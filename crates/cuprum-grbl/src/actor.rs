//! Async-actor model for a GRBL connection. One tokio task owns the serial
//! port; callers talk to it through a cloneable [`GrblHandle`]. Line commands
//! are serialized FIFO (each carries a oneshot for its terminal outcome);
//! real-time bytes preempt the queue. Status is polled internally every 200 ms
//! and published, together with raw rx/tx lines, on a broadcast channel. No
//! serde — DTO mapping lives in the UI layer, matching the rest of this crate.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::{broadcast, mpsc, oneshot};
use tokio::time::{interval, Instant, MissedTickBehavior};

use crate::command::{home, STATUS_QUERY};
use crate::parse::{parse_line, Line, MachineState, ResolvedStatus, StatusTracker};

/// Status poll cadence (matches the old hand-rolled poller thread).
const STATUS_POLL: Duration = Duration::from_millis(200);
/// Abort an `ok`-wait if GRBL goes fully silent this long (link dead/unplugged).
const SYNC_STALL_SILENCE: Duration = Duration::from_secs(4);
/// Abort if GRBL is Idle but no `ok` arrived this long after the write (lost ok).
const SYNC_IDLE_NO_ACK: Duration = Duration::from_secs(3);
/// Overall ceiling for a homing cycle (GRBL is silent for the whole cycle).
const HOMING_TIMEOUT: Duration = Duration::from_secs(120);
/// Ceiling for collecting a full `$$` settings dump.
const SETTINGS_TIMEOUT: Duration = Duration::from_secs(5);

/// Channel depths. Line/realtime queues are short (commands are interactive);
/// the event broadcast is sized to absorb a status burst without lagging a slow
/// subscriber for one poll interval.
const LINE_CAP: usize = 64;
const REALTIME_CAP: usize = 64;
const CTRL_CAP: usize = 8;
const BROADCAST_CAP: usize = 256;

/// Direction of a raw console line.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Dir {
    /// Received from GRBL.
    Rx,
    /// Sent by us.
    Tx,
}

/// Telemetry published by the actor on its broadcast channel.
#[derive(Debug, Clone)]
pub enum GrblEvent {
    /// A resolved status report (from the 200 ms poll or a manual `?`).
    Status(ResolvedStatus),
    /// A raw line for the console: rx (from GRBL) or tx (sent by us). Status
    /// reports are NOT emitted here — they arrive as [`GrblEvent::Status`] — so
    /// the 5 Hz poll can't flood the console.
    Line { dir: Dir, text: String },
}

/// Failure of a line command awaited to its terminal reply.
#[derive(Debug, Clone, thiserror::Error)]
pub enum GrblError {
    #[error("not connected")]
    NotConnected,
    #[error("machine busy")]
    Busy,
    #[error("error:{0}")]
    Error(u8),
    #[error("ALARM:{0}")]
    Alarm(u8),
    #[error("reset")]
    Reset,
    #[error("no contact")]
    NoContact,
    #[error("{0}")]
    Timeout(&'static str),
    #[error("connection lost")]
    Disconnected,
    #[error("io: {0}")]
    Io(String),
}

/// What terminal reply resolves a line command, and what it returns.
enum AwaitKind {
    /// First `ok` succeeds (plain command, e.g. `G10` / `$N=`).
    Ok,
    /// Track `[PRB:..:s]`; the terminal `ok` resolves contact / no-contact.
    Probe,
    /// Tolerate the long mid-cycle silence of `$H`.
    Home,
    /// Collect `$N=value` lines until the terminal `ok`.
    Settings,
}

/// Successful outcome of an awaited line command.
enum AwaitOk {
    Done,
    Probe(bool),
    Settings(Vec<(u16, String)>),
}

/// A line-lane request sent from a handle to the actor.
struct LineReq {
    line: String,
    kind: AwaitKind,
    /// Lease id of the caller, or `None` for a non-leased caller. While the
    /// actor is leased, a `None`/other-id request is rejected with [`GrblError::Busy`].
    lease: Option<u64>,
    /// Reply for the outcome. Dropped by fire-and-forget callers
    /// ([`GrblHandle::send_line`]), which still serialize through the queue and
    /// consume their `ok`.
    reply: oneshot::Sender<Result<AwaitOk, GrblError>>,
}

/// Out-of-band control sent to the actor (lease + shutdown).
enum Ctrl {
    /// Claim the exclusive line-lane lease under `id`; ack `Ok` or `Busy`.
    Claim(u64, oneshot::Sender<Result<(), GrblError>>),
    /// Release the lease if `id` currently holds it.
    Release(u64),
    /// Tear the actor down (close the port, end the task).
    Shutdown,
}

/// Cloneable handle to a live GRBL connection. Dropping every clone does NOT
/// stop the actor — call [`GrblHandle::shutdown`] (the UI does this on
/// disconnect); an unplug ends the actor on its own via a read error.
#[derive(Clone)]
pub struct GrblHandle {
    line_tx: mpsc::Sender<LineReq>,
    realtime_tx: mpsc::Sender<u8>,
    ctrl_tx: mpsc::Sender<Ctrl>,
    events: broadcast::Sender<GrblEvent>,
    /// Monotonic source of lease ids (a fresh id per acquire).
    lease_ids: Arc<AtomicU64>,
}

impl GrblHandle {
    /// Subscribe to the live telemetry stream (status + raw lines).
    pub fn subscribe(&self) -> broadcast::Receiver<GrblEvent> {
        self.events.subscribe()
    }

    async fn await_line(
        &self,
        line: &str,
        kind: AwaitKind,
        lease: Option<u64>,
    ) -> Result<AwaitOk, GrblError> {
        let (tx, rx) = oneshot::channel();
        self.line_tx
            .send(LineReq {
                line: line.to_string(),
                kind,
                lease,
                reply: tx,
            })
            .await
            .map_err(|_| GrblError::Disconnected)?;
        rx.await.map_err(|_| GrblError::Disconnected)?
    }

    /// Send a line and wait for `ok` (Err on error/alarm/reset/timeout).
    pub async fn send_await(&self, line: &str) -> Result<(), GrblError> {
        self.await_line(line, AwaitKind::Ok, None).await.map(|_| ())
    }

    /// `G38.2` straight probe: `Ok(true)` = contact, `Ok(false)` = no contact.
    pub async fn probe(&self, line: &str) -> Result<bool, GrblError> {
        match self.await_line(line, AwaitKind::Probe, None).await? {
            AwaitOk::Probe(c) => Ok(c),
            _ => Ok(false),
        }
    }

    /// Run `$H`, tolerating the long mid-cycle silence of the homing cycle.
    pub async fn home(&self) -> Result<(), GrblError> {
        self.await_line(home(), AwaitKind::Home, None).await.map(|_| ())
    }

    /// Send `$$` and collect every `$N=value` reply until the terminal `ok`.
    pub async fn read_settings(&self) -> Result<Vec<(u16, String)>, GrblError> {
        match self.await_line("$$", AwaitKind::Settings, None).await? {
            AwaitOk::Settings(v) => Ok(v),
            _ => Ok(Vec::new()),
        }
    }

    /// Send a line without blocking the caller on its outcome (e.g. a jog). The
    /// command is still serialized through the queue and its `ok` consumed.
    pub async fn send_line(&self, line: &str) -> Result<(), GrblError> {
        let (tx, _rx) = oneshot::channel();
        self.line_tx
            .send(LineReq {
                line: line.to_string(),
                kind: AwaitKind::Ok,
                lease: None,
                reply: tx,
            })
            .await
            .map_err(|_| GrblError::Disconnected)
        // Intentionally do not await `_rx`: the caller returns immediately.
    }

    /// Write a real-time byte (`?`, `!`, `~`, soft-reset, jog-cancel, override
    /// bytes). Preempts the serialized line queue; no ack is awaited.
    pub async fn send_realtime(&self, byte: u8) -> Result<(), GrblError> {
        self.realtime_tx
            .send(byte)
            .await
            .map_err(|_| GrblError::Disconnected)
    }

    /// Acquire the exclusive line-lane lease (used by the drill runner). While
    /// held, non-leased line commands are rejected with [`GrblError::Busy`];
    /// real-time bytes always pass. Returns `Busy` if already leased.
    pub async fn acquire_lease(&self) -> Result<GrblLease, GrblError> {
        let id = self.lease_ids.fetch_add(1, Ordering::Relaxed) + 1;
        let (ack, rx) = oneshot::channel();
        self.ctrl_tx
            .send(Ctrl::Claim(id, ack))
            .await
            .map_err(|_| GrblError::Disconnected)?;
        rx.await.map_err(|_| GrblError::Disconnected)??;
        Ok(GrblLease {
            handle: self.clone(),
            id,
        })
    }

    /// Tear the connection down: close the port and end the actor task. After
    /// this the broadcast stream closes, so subscribers learn the link is gone.
    pub async fn shutdown(&self) {
        let _ = self.ctrl_tx.send(Ctrl::Shutdown).await;
    }
}

/// Exclusive hold on the line lane. Commands issued through it carry the lease
/// id, so they pass the actor's lease gate while other callers see `Busy`.
/// Releases the lease on drop.
pub struct GrblLease {
    handle: GrblHandle,
    id: u64,
}

impl GrblLease {
    /// Send a line under the lease and wait for `ok`.
    pub async fn send_await(&self, line: &str) -> Result<(), GrblError> {
        self.handle
            .await_line(line, AwaitKind::Ok, Some(self.id))
            .await
            .map(|_| ())
    }

    /// Write a real-time byte (preempts the queue; lease-independent).
    pub async fn send_realtime(&self, byte: u8) -> Result<(), GrblError> {
        self.handle.send_realtime(byte).await
    }

    /// Subscribe to telemetry (e.g. for per-hole idle-sync during a run).
    pub fn subscribe(&self) -> broadcast::Receiver<GrblEvent> {
        self.handle.subscribe()
    }
}

impl Drop for GrblLease {
    fn drop(&mut self) {
        // Releasing the lease MUST reach the actor: a lost Release leaves the
        // line lane leased forever, so every later command returns Busy until
        // reconnect. A bare `try_send` could silently drop it if the ctrl
        // channel were momentarily full, so prefer a guaranteed async send when
        // a runtime is available (the normal case — leases live in async code),
        // and fall back to `try_send` only when dropped outside a runtime.
        let ctrl_tx = self.handle.ctrl_tx.clone();
        let id = self.id;
        match tokio::runtime::Handle::try_current() {
            Ok(rt) => {
                rt.spawn(async move {
                    let _ = ctrl_tx.send(Ctrl::Release(id)).await;
                });
            }
            Err(_) => {
                let _ = ctrl_tx.try_send(Ctrl::Release(id));
            }
        }
    }
}

/// Open `port` at `baud` and spawn the actor on the current tokio runtime.
pub async fn connect(port: &str, baud: u32) -> Result<GrblHandle, GrblError> {
    use tokio_serial::SerialPortBuilderExt;
    let stream = tokio_serial::new(port, baud)
        .timeout(Duration::from_millis(50))
        .open_native_async()
        .map_err(|e| GrblError::Io(e.to_string()))?;
    tracing::debug!(port, baud, "opened serial port (async actor)");
    Ok(spawn(stream))
}

/// Spawn the actor over any async byte stream: a real serial port in
/// [`connect`], or a [`tokio::io::duplex`] half in tests. Returns the handle.
pub fn spawn<S>(stream: S) -> GrblHandle
where
    S: AsyncRead + AsyncWrite + Send + 'static,
{
    let (line_tx, line_rx) = mpsc::channel::<LineReq>(LINE_CAP);
    let (realtime_tx, realtime_rx) = mpsc::channel::<u8>(REALTIME_CAP);
    let (ctrl_tx, ctrl_rx) = mpsc::channel::<Ctrl>(CTRL_CAP);
    let (events, _) = broadcast::channel::<GrblEvent>(BROADCAST_CAP);

    let handle = GrblHandle {
        line_tx,
        realtime_tx,
        ctrl_tx,
        events: events.clone(),
        lease_ids: Arc::new(AtomicU64::new(0)),
    };
    tokio::spawn(actor_loop(stream, line_rx, realtime_rx, ctrl_rx, events));
    handle
}

/// In-flight awaited command and its accumulators.
struct Pending {
    kind: AwaitKind,
    reply: oneshot::Sender<Result<AwaitOk, GrblError>>,
    started: Instant,
    settings: Vec<(u16, String)>,
    probe_contact: Option<bool>,
}

async fn actor_loop<S>(
    stream: S,
    mut line_rx: mpsc::Receiver<LineReq>,
    mut realtime_rx: mpsc::Receiver<u8>,
    mut ctrl_rx: mpsc::Receiver<Ctrl>,
    events: broadcast::Sender<GrblEvent>,
) where
    S: AsyncRead + AsyncWrite + Send + 'static,
{
    let (mut rd, mut wr) = tokio::io::split(stream);
    let mut tracker = StatusTracker::default();
    let mut buf: Vec<u8> = Vec::with_capacity(256);
    let mut rdbuf = [0u8; 256];

    let mut poll = interval(STATUS_POLL);
    // If a tick is missed (we were busy writing/reading), don't fire a burst of
    // catch-up `?` queries — just resume the cadence.
    poll.set_missed_tick_behavior(MissedTickBehavior::Delay);

    let mut leased: Option<u64> = None;
    let mut current: Option<Pending> = None;
    let mut last_rx = Instant::now();
    let mut idle = false;

    'main: loop {
        tokio::select! {
            biased;

            // 1. Real-time bytes: write immediately, preempting the queue. Drain
            // any further bytes already queued in the same visit, so a burst (a
            // held override ramp filling REALTIME_CAP) can't keep this top-of-the
            // biased-select branch perpetually ready and starve the read branch.
            Some(byte) = realtime_rx.recv() => {
                if wr.write_all(&[byte]).await.is_err() || wr.flush().await.is_err() {
                    break 'main;
                }
                while let Ok(b) = realtime_rx.try_recv() {
                    if wr.write_all(&[b]).await.is_err() || wr.flush().await.is_err() {
                        break 'main;
                    }
                }
            }

            // 2. Lease / shutdown control.
            Some(cmd) = ctrl_rx.recv() => {
                match cmd {
                    Ctrl::Claim(id, ack) => {
                        if leased.is_none() {
                            leased = Some(id);
                            let _ = ack.send(Ok(()));
                        } else {
                            let _ = ack.send(Err(GrblError::Busy));
                        }
                    }
                    Ctrl::Release(id) => {
                        if leased == Some(id) {
                            leased = None;
                        }
                    }
                    Ctrl::Shutdown => break,
                }
            }

            // 3. Status poll tick: query `?` and check the in-flight deadline.
            _ = poll.tick() => {
                if wr.write_all(&[STATUS_QUERY]).await.is_err() || wr.flush().await.is_err() {
                    break;
                }
                if let Some(p) = &current {
                    if let Some(err) = deadline_exceeded(&p.kind, p.started, last_rx, idle) {
                        let p = current.take().expect("checked Some above");
                        let _ = p.reply.send(Err(err));
                    }
                }
            }

            // 4. Incoming serial bytes.
            n = rd.read(&mut rdbuf) => {
                match n {
                    Ok(0) | Err(_) => break, // link closed / unplugged
                    Ok(n) => {
                        last_rx = Instant::now();
                        buf.extend_from_slice(&rdbuf[..n]);
                        while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
                            let raw: Vec<u8> = buf.drain(..=pos).collect();
                            let line = String::from_utf8_lossy(&raw)
                                .trim_end_matches(['\r', '\n'])
                                .to_string();
                            let parsed = parse_line(&line);
                            route_line(&parsed, &line, &events, &mut tracker, &mut idle);
                            resolve_pending(&mut current, &parsed);
                        }
                    }
                }
            }

            // 5. Next line command — only when nothing is in flight (FIFO).
            Some(req) = line_rx.recv(), if current.is_none() => {
                if leased.is_some() && req.lease != leased {
                    let _ = req.reply.send(Err(GrblError::Busy));
                } else if wr.write_all(req.line.as_bytes()).await.is_err()
                    || wr.write_all(b"\n").await.is_err()
                    || wr.flush().await.is_err()
                {
                    let _ = req.reply.send(Err(GrblError::Disconnected));
                    break;
                } else {
                    let _ = events.send(GrblEvent::Line {
                        dir: Dir::Tx,
                        text: req.line.clone(),
                    });
                    current = Some(Pending {
                        kind: req.kind,
                        reply: req.reply,
                        started: Instant::now(),
                        settings: Vec::new(),
                        probe_contact: None,
                    });
                }
            }

            else => break,
        }
    }

    // The actor is ending: fail any in-flight command so its caller unblocks
    // instead of waiting for a reply that will never come. Dropping `events`
    // (on return) closes the broadcast so subscribers learn the link is gone.
    if let Some(p) = current.take() {
        let _ = p.reply.send(Err(GrblError::Disconnected));
    }
}

/// Broadcast a parsed line: status reports resolve + emit a `Status` event
/// (never a console `Line`, so the 5 Hz poll can't flood the console); every
/// other line is emitted as an rx console `Line`.
fn route_line(
    parsed: &Line,
    raw: &str,
    events: &broadcast::Sender<GrblEvent>,
    tracker: &mut StatusTracker,
    idle: &mut bool,
) {
    match parsed {
        Line::Status(rep) => {
            let s = tracker.resolve(rep);
            *idle = matches!(s.state, MachineState::Idle);
            let _ = events.send(GrblEvent::Status(s));
        }
        _ => {
            let _ = events.send(GrblEvent::Line {
                dir: Dir::Rx,
                text: raw.to_string(),
            });
        }
    }
}

/// Advance the in-flight command toward its terminal reply, resolving its
/// oneshot when reached and clearing `current`.
fn resolve_pending(current: &mut Option<Pending>, parsed: &Line) {
    let Some(p) = current.as_mut() else {
        // No waiter: a stray `ok` (e.g. from a fire-and-forget already resolved
        // by timeout) is simply dropped.
        return;
    };
    // Determine the outcome, if this line is terminal for the current kind.
    let outcome: Option<Result<AwaitOk, GrblError>> = match (&p.kind, parsed) {
        // Probe report: remember contact until the terminal `ok`.
        (AwaitKind::Probe, Line::Probe { success, .. }) => {
            p.probe_contact = Some(*success);
            None
        }
        (AwaitKind::Probe, Line::Ok) => Some(match p.probe_contact {
            Some(true) => Ok(AwaitOk::Probe(true)),
            _ => Ok(AwaitOk::Probe(false)),
        }),
        // Settings: accumulate `$N=value` until `ok`.
        (AwaitKind::Settings, Line::Setting { n, value }) => {
            p.settings.push((*n, value.clone()));
            None
        }
        (AwaitKind::Settings, Line::Ok) => {
            Some(Ok(AwaitOk::Settings(std::mem::take(&mut p.settings))))
        }
        // Plain ok / home: the first `ok` is success.
        (_, Line::Ok) => Some(Ok(AwaitOk::Done)),
        // Failures common to every kind.
        (_, Line::Error(n)) => Some(Err(GrblError::Error(*n))),
        (_, Line::Alarm(n)) => Some(Err(GrblError::Alarm(*n))),
        // A reset (welcome banner) mid-command means the line was aborted.
        (_, Line::Welcome(_)) => Some(Err(GrblError::Reset)),
        _ => None,
    };
    if let Some(result) = outcome {
        let p = current.take().expect("checked Some above");
        let _ = p.reply.send(result);
    }
}

/// Whether the in-flight command has exceeded its deadline. `Ok`/`Probe` abort
/// on total silence (dead link) or Idle-without-ack (lost ok); `Settings`/`Home`
/// only guard against a link that never answers.
fn deadline_exceeded(
    kind: &AwaitKind,
    started: Instant,
    last_rx: Instant,
    idle: bool,
) -> Option<GrblError> {
    match kind {
        AwaitKind::Ok | AwaitKind::Probe => {
            if last_rx.elapsed() > SYNC_STALL_SILENCE {
                return Some(GrblError::Timeout("no response from machine"));
            }
            if idle && started.elapsed() > SYNC_IDLE_NO_ACK {
                return Some(GrblError::Timeout("machine idle, no ack (lost ok)"));
            }
            None
        }
        AwaitKind::Settings => (started.elapsed() > SETTINGS_TIMEOUT)
            .then_some(GrblError::Timeout("no response from machine")),
        AwaitKind::Home => {
            (started.elapsed() > HOMING_TIMEOUT).then_some(GrblError::Timeout("homing timeout"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::command::SOFT_RESET;
    use tokio::io::{DuplexStream, ReadHalf, WriteHalf};

    /// The "GRBL on the other end of the wire": reads what the actor writes
    /// (transparently dropping the bare `?` status polls) and writes replies.
    struct Fake {
        rd: ReadHalf<DuplexStream>,
        wr: WriteHalf<DuplexStream>,
        buf: Vec<u8>,
    }

    impl Fake {
        fn new(s: DuplexStream) -> Self {
            let (rd, wr) = tokio::io::split(s);
            Self {
                rd,
                wr,
                buf: Vec::new(),
            }
        }

        /// Next full command line the actor sent, with `?` poll bytes stripped.
        /// Skips lines that were nothing but a poll.
        async fn recv_cmd(&mut self) -> String {
            loop {
                if let Some(pos) = self.buf.iter().position(|&b| b == b'\n') {
                    let raw: Vec<u8> = self.buf.drain(..=pos).collect();
                    // Keep only the printable command text: drop the `?` status
                    // polls and any real-time bytes (0x18 soft-reset, 0x85
                    // jog-cancel, 0x90.. overrides) that interleave the stream.
                    let kept: Vec<u8> = raw
                        .into_iter()
                        .filter(|&b| (0x20..=0x7E).contains(&b) && b != b'?')
                        .collect();
                    let s = String::from_utf8_lossy(&kept)
                        .trim_end_matches(['\r', '\n'])
                        .trim()
                        .to_string();
                    if s.is_empty() {
                        continue;
                    }
                    return s;
                }
                let mut tmp = [0u8; 128];
                let n = self.rd.read(&mut tmp).await.unwrap();
                assert!(n > 0, "actor closed the stream unexpectedly");
                self.buf.extend_from_slice(&tmp[..n]);
            }
        }

        /// Next byte the actor wrote that is NOT a `?` status poll.
        async fn recv_nonpoll_byte(&mut self) -> u8 {
            loop {
                if !self.buf.is_empty() {
                    let b = self.buf.remove(0);
                    if b != b'?' {
                        return b;
                    }
                    continue;
                }
                let mut tmp = [0u8; 128];
                let n = self.rd.read(&mut tmp).await.unwrap();
                assert!(n > 0, "actor closed the stream unexpectedly");
                self.buf.extend_from_slice(&tmp[..n]);
            }
        }

        async fn send(&mut self, line: &str) {
            self.wr.write_all(line.as_bytes()).await.unwrap();
            self.wr.write_all(b"\r\n").await.unwrap();
            self.wr.flush().await.unwrap();
        }
    }

    fn setup() -> (GrblHandle, Fake) {
        let (client, fake) = tokio::io::duplex(1024);
        (spawn(client), Fake::new(fake))
    }

    #[tokio::test]
    async fn send_await_resolves_on_ok() {
        let (h, mut fake) = setup();
        let fut = h.send_await("G10 L20 P1 Z0");
        let (cmd, res) = tokio::join!(
            async {
                let c = fake.recv_cmd().await;
                fake.send("ok").await;
                c
            },
            fut,
        );
        assert_eq!(cmd, "G10 L20 P1 Z0");
        res.unwrap();
    }

    #[tokio::test]
    async fn send_await_maps_error() {
        let (h, mut fake) = setup();
        let fut = h.send_await("G0 X1");
        let (_, res) = tokio::join!(
            async {
                fake.recv_cmd().await;
                fake.send("error:9").await;
            },
            fut,
        );
        assert!(matches!(res, Err(GrblError::Error(9))), "got {res:?}");
    }

    #[tokio::test]
    async fn send_await_maps_alarm() {
        let (h, mut fake) = setup();
        let fut = h.send_await("G0 X1");
        let (_, res) = tokio::join!(
            async {
                fake.recv_cmd().await;
                fake.send("ALARM:1").await;
            },
            fut,
        );
        assert!(matches!(res, Err(GrblError::Alarm(1))), "got {res:?}");
    }

    #[tokio::test]
    async fn send_await_maps_reset() {
        let (h, mut fake) = setup();
        let fut = h.send_await("$H");
        let (_, res) = tokio::join!(
            async {
                fake.recv_cmd().await;
                fake.send("Grbl 1.1h ['$' for help]").await;
            },
            fut,
        );
        assert!(matches!(res, Err(GrblError::Reset)), "got {res:?}");
    }

    #[tokio::test]
    async fn read_settings_collects_until_ok() {
        let (h, mut fake) = setup();
        let fut = h.read_settings();
        let (cmd, res) = tokio::join!(
            async {
                let c = fake.recv_cmd().await;
                fake.send("$0=10").await;
                fake.send("$130=200.000").await;
                fake.send("ok").await;
                c
            },
            fut,
        );
        assert_eq!(cmd, "$$");
        assert_eq!(
            res.unwrap(),
            vec![(0, "10".to_string()), (130, "200.000".to_string())]
        );
    }

    #[tokio::test]
    async fn probe_reports_contact() {
        let (h, mut fake) = setup();
        let fut = h.probe("G38.2 Z-5 F50");
        let (_, res) = tokio::join!(
            async {
                fake.recv_cmd().await;
                fake.send("[PRB:0.000,0.000,-3.250:1]").await;
                fake.send("ok").await;
            },
            fut,
        );
        assert!(res.unwrap());
    }

    #[tokio::test]
    async fn probe_reports_no_contact_on_bare_ok() {
        let (h, mut fake) = setup();
        let fut = h.probe("G38.2 Z-5 F50");
        let (_, res) = tokio::join!(
            async {
                fake.recv_cmd().await;
                // s=0 => no contact within travel
                fake.send("[PRB:0.000,0.000,0.000:0]").await;
                fake.send("ok").await;
            },
            fut,
        );
        assert!(!res.unwrap());
    }

    #[tokio::test]
    async fn realtime_byte_passes_while_line_in_flight() {
        let (h, mut fake) = setup();
        // A line is in flight (no ok yet)...
        let h2 = h.clone();
        let jh = tokio::spawn(async move { h2.send_await("G4 P10").await });
        assert_eq!(fake.recv_cmd().await, "G4 P10");
        // ...a real-time byte still reaches the wire (preempts the queue).
        h.send_realtime(SOFT_RESET).await.unwrap();
        assert_eq!(fake.recv_nonpoll_byte().await, SOFT_RESET);
        // The soft-reset's welcome banner then aborts the in-flight line.
        fake.send("Grbl 1.1h ['$' for help]").await;
        assert!(matches!(jh.await.unwrap(), Err(GrblError::Reset)));
    }

    #[tokio::test]
    async fn lease_rejects_other_callers_then_frees_on_drop() {
        let (h, mut fake) = setup();
        let lease = h.acquire_lease().await.unwrap();

        // A non-leased line command is rejected without ever hitting the wire.
        assert!(matches!(
            h.send_await("G0 X1").await,
            Err(GrblError::Busy)
        ));

        // The lease holder's command passes.
        let fut = lease.send_await("G10 L20 P1 X0");
        let (cmd, res) = tokio::join!(
            async {
                let c = fake.recv_cmd().await;
                fake.send("ok").await;
                c
            },
            fut,
        );
        assert_eq!(cmd, "G10 L20 P1 X0");
        res.unwrap();

        // Releasing the lease (drop) lets a plain command through again.
        drop(lease);
        let fut = h.send_await("G0 X2");
        let (cmd, res) = tokio::join!(
            async {
                let c = fake.recv_cmd().await;
                fake.send("ok").await;
                c
            },
            fut,
        );
        assert_eq!(cmd, "G0 X2");
        res.unwrap();
    }

    #[tokio::test]
    async fn events_carry_status_and_lines() {
        let (h, mut fake) = setup();
        let mut sub = h.subscribe();
        fake.send("<Idle|MPos:1.000,2.000,3.000|FS:0,0>").await;
        fake.send("[MSG:hello]").await;

        // First a resolved Status, then the message as an rx console line.
        macro_rules! recv {
            () => {
                tokio::time::timeout(Duration::from_secs(1), sub.recv())
                    .await
                    .expect("event timeout")
                    .expect("broadcast closed")
            };
        }
        match recv!() {
            GrblEvent::Status(s) => {
                assert_eq!(s.state, MachineState::Idle);
                assert_eq!(s.mpos, [1.0, 2.0, 3.0]);
            }
            other => panic!("expected Status, got {other:?}"),
        }
        match recv!() {
            GrblEvent::Line { dir, text } => {
                assert_eq!(dir, Dir::Rx);
                assert_eq!(text, "[MSG:hello]");
            }
            other => panic!("expected Line, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn send_line_serializes_before_next_await() {
        let (h, mut fake) = setup();
        // Fire-and-forget jog returns immediately, but its `ok` is consumed and
        // the next command waits behind it (FIFO on the single line lane).
        h.send_line("$J=G91 X1 F500").await.unwrap();
        let fut = h.send_await("G10 L20 P1 Z0");
        let (cmds, res) = tokio::join!(
            async {
                let c1 = fake.recv_cmd().await;
                fake.send("ok").await; // jog accepted
                let c2 = fake.recv_cmd().await;
                fake.send("ok").await; // G10 accepted
                (c1, c2)
            },
            fut,
        );
        assert_eq!(cmds.0, "$J=G91 X1 F500");
        assert_eq!(cmds.1, "G10 L20 P1 Z0");
        res.unwrap();
    }

    #[tokio::test]
    async fn realtime_burst_does_not_starve_reads() {
        use crate::command::FEED_OVERRIDE_PLUS_1;
        let (h, mut fake) = setup();
        // A burst of real-time override bytes (a held UI ramp) must not block
        // the actor from reading replies: a following awaited command still
        // resolves.
        for _ in 0..32 {
            h.send_realtime(FEED_OVERRIDE_PLUS_1).await.unwrap();
        }
        let fut = h.send_await("G0 X1");
        let (cmd, res) = tokio::join!(
            async {
                let c = fake.recv_cmd().await; // override bytes are filtered out
                fake.send("ok").await;
                c
            },
            fut,
        );
        assert_eq!(cmd, "G0 X1");
        res.unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn silence_times_out() {
        let (h, _fake) = setup();
        // No reply ever arrives; the link is "silent". With the clock paused the
        // runtime auto-advances through the poll ticks until the 4 s silence
        // deadline fires. `_fake` is held so the actor's writes don't error.
        let res = h.send_await("G0 X1").await;
        assert!(
            matches!(res, Err(GrblError::Timeout("no response from machine"))),
            "got {res:?}"
        );
    }
}
