import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def node_eval_es(code: str) -> str:
    result = subprocess.run(
        ["node", "--input-type=module", "-e", code],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert result.returncode == 0, result.stderr
    return result.stdout.strip()


def test_group_metadata_cache_ttl_and_prune():
    script = """
    import { GroupMetadataCache } from './src/groupMetadataCache.js';
    const cache = new GroupMetadataCache({ ttlMs: 20 });
    cache.set('group-1', { id: 'group-1', subject: 'Hello' });
    const hit = cache.get('group-1')?.subject || null;
    cache.prime({ 'group-2': { id: 'group-2', subject: 'World' } });
    const primeHit = cache.get('group-2')?.subject || null;
    cache.invalidate('group-1');
    const afterInvalidate = cache.get('group-1') || null;
    cache.set('group-ttl', { id: 'group-ttl', subject: 'Soon stale' });
    await new Promise((resolve) => setTimeout(resolve, 40));
    cache.prune();
    const expired = cache.get('group-ttl') || null;
    cache.clear();
    const afterClear = cache.get('group-2') || null;
    console.log(JSON.stringify({ hit, primeHit, afterInvalidate, expired, afterClear }));
  """
    output = node_eval_es(script)
    payload = json.loads(output)
    assert payload["hit"] == "Hello"
    assert payload["primeHit"] == "World"
    assert payload["afterInvalidate"] is None
    assert payload["expired"] is None
    assert payload["afterClear"] is None


def test_group_refresh_scheduler_debounces_and_clears():
    script = """
    import { createGroupRefreshScheduler } from './src/groupMetadataRefresh.js';
    const calls = [];
    const scheduler = createGroupRefreshScheduler({
      refreshFn: async (jid) => calls.push(jid),
      delayMs: 20,
    });
    scheduler.schedule('abc');
    scheduler.schedule('abc');
    scheduler.schedule('def');
    await new Promise((resolve) => setTimeout(resolve, 40));
    scheduler.schedule('skip-me');
    scheduler.clearAll();
    await new Promise((resolve) => setTimeout(resolve, 30));
    console.log(JSON.stringify({ calls }));
  """
    output = node_eval_es(script)
    payload = json.loads(output)
    assert sorted(payload["calls"]) == ["abc", "def"]
