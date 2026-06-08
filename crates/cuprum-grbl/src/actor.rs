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
        // Best-effort, non-blocking release: if the actor is gone the lease is
        // moot anyway. `try_send` avoids needing an async context in `drop`.
        let _ = self.handle.ctrl_tx.try_send(Ctrl::Release(self.id));
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

    loop {
        tokio::select! {
            biased;

            // 1. Real-time bytes: write immediately, preempting the queue.
            Some(byte) = realtime_rx.recv() => {
                if wr.write_all(&[byte]).await.is_err() || wr.flush().await.is_err() {
                    break;
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
