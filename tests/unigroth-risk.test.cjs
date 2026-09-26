const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const realFetch = global.fetch;
global.fetch = async () => { throw new Error('Network disabled in this local audit'); };
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sharesecure-zk-audit-'));
fs.writeFileSync(path.join(temp, 'package.json'), '{"type":"module"}');
fs.cpSync(path.resolve(__dirname, '../functions'), path.join(temp, 'functions'), { recursive: true });
const load = file => import(pathToFileURL(path.join(temp, 'functions', file)).href);
after(() => {
  global.fetch = realFetch;
  assert.equal(path.dirname(path.resolve(temp)), path.resolve(os.tmpdir()));
  assert(path.basename(temp).startsWith('sharesecure-zk-audit-'));
  fs.rmSync(temp, { recursive: true, force: true });
});

test('experimental spot-check verifier can accept false statements; production must reject this proof path', async () => {
  const { Circuit } = await load('lib/unigroth/circuit.js');
  const { prove } = await load('lib/unigroth/prover.js');
  const { verify } = await load('lib/unigroth/verifier.js');
  const { mimcHash } = await load('lib/unigroth/index.js');
  const c = new Circuit('synthetic-auth-audit');
  const secret = c.privateInput('secret'), commitment = c.publicInput('commitment');
  const nonce = c.publicInput('nonce'), nullifier = c.publicInput('nullifier');
  const h1 = c.hash(secret); c.assertEqual(h1, commitment);
  const h2 = c.hash(c.add(h1, nonce)); c.assertEqual(h2, nullifier);
  const inputs = { secret: 999n, commitment: mimcHash(123n), nonce: 7n, nullifier: mimcHash(mimcHash(123n) + 7n) };
  const witness = c.computeWitness(inputs);
  assert.equal(c.checkWitness(witness).valid, false);
  // The client is untrusted: bypass its local check without changing the
  // verifier's circuit, then lie about the unverified aggregate.
  const dishonestProverCircuit = Object.create(c);
  dishonestProverCircuit.checkWitness = () => ({ valid: true });
  let accepted = 0, forged;
  for (let i = 0; i < 10; i++) {
    const proof = await prove(dishonestProverCircuit, witness, Object.fromEntries(c.publicInputs.map(p => [p.name, inputs[p.name].toString()])));
    proof.aggregatedCheck = '0';
    if ((await verify(c, proof)).passed) { accepted++; forged = proof; }
  }
  assert(accepted > 0, 'If the verifier is replaced, update this risk reproduction after independent review');
  console.log(`Synthetic false statements accepted by experimental verifier: ${accepted}/10`);
  const adapter = await load('_zk.js');
  const result = await adapter.verifyProof({ proof: forged, nullifier: inputs.nullifier.toString(), nonce: '7' }, {});
  assert.equal(result.valid, false);
  assert.match(result.error, /disabled/i);
});
