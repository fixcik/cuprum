//! Upload a sliced file to the printer's HTTP server.
//!
//! `POST http://<ip>:3030/uploadFile/upload` (multipart/form-data) per SDCP V3.0.0.
//! Files are nominally sent in <=1 MB packets; our exposure `.goo` is ~200 KB so we
//! send a single packet (Offset 0, whole file). This transfers a file only — it does
//! NOT start a print.

use anyhow::{bail, Context, Result};
use md5::{Digest, Md5};
use reqwest::blocking::multipart::{Form, Part};

use super::CONTROL_PORT;

#[derive(Debug, Clone)]
pub struct UploadOutcome {
    pub filename: String,
    pub size: usize,
    pub md5: String,
}

/// Upload `data` to the printer as `filename`. Single-packet (file must be < 1 MB
/// for now). Returns Ok only when the printer reports `code == "000000"`.
pub fn upload_file(ip: &str, filename: &str, data: &[u8]) -> Result<UploadOutcome> {
    let md5_hex = md5_hex(data);
    let uuid = uuid::Uuid::new_v4().simple().to_string();
    let url = format!("http://{ip}:{CONTROL_PORT}/uploadFile/upload");

    let file_part = Part::bytes(data.to_vec())
        .file_name(filename.to_string())
        .mime_str("application/octet-stream")?;
    let form = Form::new()
        .text("S-File-MD5", md5_hex.clone())
        .text("Check", "1")
        .text("Offset", "0")
        .text("Uuid", uuid)
        .text("TotalSize", data.len().to_string())
        .part("File", file_part);

    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()?;
    let resp = client
        .post(&url)
        .multipart(form)
        .send()
        .with_context(|| format!("POST {url}"))?;

    let status = resp.status();
    let body = resp.text().unwrap_or_default();
    if !status.is_success() {
        bail!("upload failed: HTTP {status}: {body}");
    }

    // Response: {"code":"000000","messages":null,"data":{},"success":true}
    let json: serde_json::Value =
        serde_json::from_str(&body).with_context(|| format!("non-JSON response: {body}"))?;
    let ok = json
        .get("success")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
        || json.get("code").and_then(|v| v.as_str()) == Some("000000");
    if !ok {
        bail!("printer rejected upload: {body}");
    }

    Ok(UploadOutcome {
        filename: filename.to_string(),
        size: data.len(),
        md5: md5_hex,
    })
}

fn md5_hex(data: &[u8]) -> String {
    let mut hasher = Md5::new();
    hasher.update(data);
    let digest = hasher.finalize();
    let mut out = String::with_capacity(32);
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn md5_hex_known_vector() {
        // MD5("") = d41d8cd98f00b204e9800998ecf8427e
        assert_eq!(md5_hex(b""), "d41d8cd98f00b204e9800998ecf8427e");
    }
}
