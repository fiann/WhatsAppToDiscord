import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def node_eval(code: str) -> str:
    result = subprocess.run(
        ["node", "-e", code],
        capture_output=True,
        text=True,
        cwd=ROOT,
    )
    assert result.returncode == 0, result.stderr
    return result.stdout.strip()


def test_multi_file_auth_state_handles_tctoken(tmp_path):
    auth_dir = tmp_path / "auth"
    auth_dir.mkdir()
    script = f"""
const fs = require('node:fs');
(async () => {{
  const {{ useMultiFileAuthState }} = await import('@whiskeysockets/baileys');
  const dir = {json.dumps(str(auth_dir))};
  const {{ state }} = await useMultiFileAuthState(dir);
  await state.keys.set({{ tctoken: {{ test: Buffer.from('rc8') }} }});
  const stored = await state.keys.get('tctoken', ['test']);
  const files = fs.readdirSync(dir).filter((name) => name.startsWith('tctoken-'));
  console.log(JSON.stringify({{
    stored: stored.test ? stored.test.toString('base64') : null,
    files,
  }}));
}})().catch((err) => {{
  console.error(err);
  process.exit(1);
}});
"""
    output = node_eval(script)
    payload = json.loads(output)
    assert payload["stored"] == "cmM4"
    assert any(name.startswith("tctoken-") for name in payload["files"])
