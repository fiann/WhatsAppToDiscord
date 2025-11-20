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


def test_multi_file_auth_state_handles_new_signal_entries(tmp_path):
    auth_dir = tmp_path / "auth"
    auth_dir.mkdir()
    script = f"""
const fs = require('node:fs');
(async () => {{
  const {{ useMultiFileAuthState }} = await import('@whiskeysockets/baileys');
  const dir = {json.dumps(str(auth_dir))};
  const {{ state }} = await useMultiFileAuthState(dir);
  await state.keys.set({{
    tctoken: {{ test: Buffer.from('rc8') }},
    'lid-mapping': {{ pn: '161040050426060:29@lid' }},
    'device-index': {{ primary: Buffer.from('device-index') }},
    'device-list': {{ primary: Buffer.from('device-list') }},
  }});
  const stored = await state.keys.get('tctoken', ['test']);
  const lidMapping = await state.keys.get('lid-mapping', ['pn']);
  const deviceIndex = await state.keys.get('device-index', ['primary']);
  const deviceList = await state.keys.get('device-list', ['primary']);
  const files = fs.readdirSync(dir).filter((name) => name.match(/^(tctoken|lid-mapping|device-(index|list))/));
  console.log(JSON.stringify({{
    stored: stored.test ? stored.test.toString('base64') : null,
    lidMapping,
    deviceIndex: deviceIndex.primary ? deviceIndex.primary.toString('utf8') : null,
    deviceList: deviceList.primary ? deviceList.primary.toString('utf8') : null,
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
    assert payload["lidMapping"].get("pn") == "161040050426060:29@lid"
    assert payload["deviceIndex"] == "device-index"
    assert payload["deviceList"] == "device-list"
    assert any(name.startswith("tctoken-") for name in payload["files"])
    assert any(name.startswith("lid-mapping-") for name in payload["files"])
    assert any(name.startswith("device-index-") for name in payload["files"])
    assert any(name.startswith("device-list-") for name in payload["files"])
