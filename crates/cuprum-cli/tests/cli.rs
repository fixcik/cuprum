use assert_cmd::Command;
use predicates::prelude::*;

fn gerber_fixture() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../testdata/gerber/plaid")
}

#[test]
fn info_on_gerber_dir_lists_layers() {
    Command::cargo_bin("cuprum")
        .unwrap()
        .args(["info", gerber_fixture().to_str().unwrap()])
        .assert()
        .success()
        .stdout(predicate::str::contains("layers ("));
}

#[test]
fn info_json_is_parseable() {
    let out = Command::cargo_bin("cuprum")
        .unwrap()
        .args(["--json", "info", gerber_fixture().to_str().unwrap()])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let v: serde_json::Value = serde_json::from_slice(&out).unwrap();
    assert!(v["layers"].is_array());
}

#[test]
fn missing_input_errors_with_code_1() {
    Command::cargo_bin("cuprum")
        .unwrap()
        .args(["info", "/no/such/path"])
        .assert()
        .code(1);
}

#[test]
fn render_writes_a_png() {
    let dir = tempfile::tempdir().unwrap();
    let out = dir.path().join("b.png");
    Command::cargo_bin("cuprum")
        .unwrap()
        .args([
            "render",
            gerber_fixture().to_str().unwrap(),
            "-o",
            out.to_str().unwrap(),
        ])
        .assert()
        .success();
    let bytes = std::fs::read(&out).unwrap();
    assert!(bytes.starts_with(&[0x89, b'P', b'N', b'G']), "PNG magic");
}

#[test]
fn svg_writes_an_svg() {
    let dir = tempfile::tempdir().unwrap();
    let out = dir.path().join("b.svg");
    Command::cargo_bin("cuprum")
        .unwrap()
        .args([
            "svg",
            gerber_fixture().to_str().unwrap(),
            "-o",
            out.to_str().unwrap(),
        ])
        .assert()
        .success();
    let s = std::fs::read_to_string(&out).unwrap();
    assert!(s.contains("<svg"), "is an SVG document");
}
