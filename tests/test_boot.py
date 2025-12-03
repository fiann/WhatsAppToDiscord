import os
import subprocess

ROOT = os.path.dirname(os.path.dirname(__file__))


def test_smoke_boots_successfully():
    env = os.environ.copy()
    env["WA2DC_SMOKE_TEST"] = "1"
    result = subprocess.run(
        ["node", "src/index.js"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=120,
        env=env,
    )
    assert result.returncode == 0, result.stderr
    combined_output = f"{result.stdout}\n{result.stderr}"
    assert "Smoke test completed successfully." in combined_output
