use assert_cmd::Command;
use predicates::prelude::*;

/// Sum of all located-hotspot lists in geo. Counts arrays whose key ends with
/// "Hotspots" or equals "thinTraceConductors" (matches the camelCase JSON names).
fn geo_hotspot_total(v: &serde_json::Value) -> usize {
    let geo = &v["metrics"]["geo"];
    let obj = geo.as_object().unwrap();
    obj.iter()
        .filter(|(k, _)| k.ends_with("Hotspots") || k.as_str() == "thinTraceConductors")
        .filter_map(|(_, val)| val.as_array().map(|a| a.len()))
        .sum()
}

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

#[test]
fn mesh_glb_default() {
    let dir = tempfile::tempdir().unwrap();
    let out = dir.path().join("b.glb");
    Command::cargo_bin("cuprum")
        .unwrap()
        .args([
            "3d",
            gerber_fixture().to_str().unwrap(),
            "-o",
            out.to_str().unwrap(),
        ])
        .assert()
        .success();
    assert_eq!(&std::fs::read(&out).unwrap()[0..4], b"glTF");
}

#[test]
fn mesh_stl_format_flag() {
    let dir = tempfile::tempdir().unwrap();
    let out = dir.path().join("b.stl");
    Command::cargo_bin("cuprum")
        .unwrap()
        .args([
            "3d",
            gerber_fixture().to_str().unwrap(),
            "-o",
            out.to_str().unwrap(),
            "--format",
            "stl",
        ])
        .assert()
        .success();
    assert!(std::fs::read(&out).unwrap().len() > 84);
}

#[test]
fn mesh_obj_writes_obj_and_mtl() {
    let dir = tempfile::tempdir().unwrap();
    let out = dir.path().join("b.obj");
    Command::cargo_bin("cuprum")
        .unwrap()
        .args([
            "3d",
            gerber_fixture().to_str().unwrap(),
            "-o",
            out.to_str().unwrap(),
            "--format",
            "obj",
        ])
        .assert()
        .success();
    assert!(out.exists() && out.with_extension("mtl").exists());
}

#[test]
fn check_json_has_metrics_and_gate() {
    let out = Command::cargo_bin("cuprum")
        .unwrap()
        .args(["--json", "check", gerber_fixture().to_str().unwrap()])
        .assert()
        .get_output()
        .stdout
        .clone();
    let v: serde_json::Value = serde_json::from_slice(&out).unwrap();
    assert!(v["metrics"].is_object());
    // Severity serializes lowercase ("ok"/"block"), consistent with the rest of the API.
    assert!(matches!(
        v["gate"]["worst"].as_str(),
        Some("ok") | Some("block")
    ));
}

/// Plaid fixture hotspot totals (observed 2026-06-04):
///   default (no flag): 0   — all lists are stripped
///   --hotspots flag:   8042 — annular 390, clearance 1000, copperWidth 293,
///                            drill 500, maskDam 1000, silk 4000, thinTrace 133,
///                            trace 726, overshoot 0
#[test]
fn check_omits_hotspots_by_default() {
    let out = Command::cargo_bin("cuprum")
        .unwrap()
        .args(["--json", "check", gerber_fixture().to_str().unwrap()])
        .assert()
        .get_output()
        .stdout
        .clone();
    let v: serde_json::Value = serde_json::from_slice(&out).unwrap();
    assert_eq!(
        geo_hotspot_total(&v),
        0,
        "default output should carry no hotspots (all lists stripped)"
    );
}

#[test]
fn check_includes_hotspots_with_flag() {
    let out = Command::cargo_bin("cuprum")
        .unwrap()
        .args([
            "--json",
            "check",
            gerber_fixture().to_str().unwrap(),
            "--hotspots",
        ])
        .assert()
        .get_output()
        .stdout
        .clone();
    let v: serde_json::Value = serde_json::from_slice(&out).unwrap();
    // Plaid is a real PCB — it has thousands of located DFM issues.
    // Assert > 0 (non-vacuous) and that the value substantially exceeds the default.
    let total = geo_hotspot_total(&v);
    assert!(
        total > 0,
        "--hotspots flag must surface located hotspots for the plaid board (got {total})"
    );
    // Structural: individual categories present and non-empty.
    let geo = &v["metrics"]["geo"];
    assert!(
        geo["clearanceHotspots"].as_array().map_or(0, |a| a.len()) > 0,
        "clearanceHotspots must be non-empty with --hotspots on plaid"
    );
    assert!(
        geo["drillHotspots"].as_array().map_or(0, |a| a.len()) > 0,
        "drillHotspots must be non-empty with --hotspots on plaid"
    );
}

#[test]
fn check_gate_fails_with_strict_profile() {
    let dir = tempfile::tempdir().unwrap();
    let prof = dir.path().join("p.json");
    std::fs::write(
        &prof,
        r#"{"minTraceMm":99.0,"minClearanceMm":99.0,"minDrillMm":99.0,"minAnnularMm":99.0}"#,
    )
    .unwrap();
    Command::cargo_bin("cuprum")
        .unwrap()
        .args([
            "check",
            gerber_fixture().to_str().unwrap(),
            "--profile",
            prof.to_str().unwrap(),
        ])
        .assert()
        .code(2);
}
