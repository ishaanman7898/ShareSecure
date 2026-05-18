// UniGroth prover — generates zero-knowledge proofs
// Browser ESM port: async (Web Crypto inside).
// Source: github.com/MeridianAlgo/UniGroth/blob/main/src/prover.js (ISC)

import * as F from './field.js';
import { MerkleTree, Transcript, bytesToHex } from './commitment.js';

export async function prove(circuit, witness, publicInputs) {
  const t0 = (typeof performance !== 'undefined') ? performance.now() : Date.now();

  // 1. Verify witness satisfies all constraints
  const check = circuit.checkWitness(witness);
  if (!check.valid) {
    throw new Error(`witness does not satisfy constraint ${check.failedConstraint}`);
  }

  // 2. Blind witness for zero-knowledge
  const blindingFactors = [];
  for (let i = 0; i < circuit.nSignals; i++) blindingFactors.push(F.random());

  // 3. Commit to witness + blinding via merkle trees
  const witnessTree = await MerkleTree.create(witness);
  const witnessRoot = witnessTree.root();
  const blindTree = await MerkleTree.create(blindingFactors);
  const blindRoot = blindTree.root();

  // 4. Fiat-Shamir transcript
  const transcript = await Transcript.create('unigroth_prove_v1');
  await transcript.absorbBytes(witnessRoot);
  await transcript.absorbBytes(blindRoot);
  for (const pi of circuit.publicInputs) {
    await transcript.absorb(witness[pi.index]);
  }

  // 5. Random challenge for constraint aggregation
  const alpha = await transcript.squeeze();

  // 6. Aggregated constraint evaluation: T = Σ αⁱ · [(a·w)(b·w) - c·w]
  let T = 0n;
  let alphaI = 1n;
  for (let i = 0; i < circuit.constraints.length; i++) {
    const con = circuit.constraints[i];
    const aVal = circuit._evalLC(con.a, witness);
    const bVal = circuit._evalLC(con.b, witness);
    const cVal = circuit._evalLC(con.c, witness);
    const eval_i = F.sub(F.mul(aVal, bVal), cVal);
    T = F.add(T, F.mul(alphaI, eval_i));
    alphaI = F.mul(alphaI, alpha);
  }

  // 7. Blinded constraint evaluations
  const beta = await transcript.squeeze();
  const blindedEvals = [];
  for (let i = 0; i < circuit.constraints.length; i++) {
    const con = circuit.constraints[i];
    const aVal = circuit._evalLC(con.a, witness);
    const bVal = circuit._evalLC(con.b, witness);
    const cVal = circuit._evalLC(con.c, witness);
    blindedEvals.push({
      a: F.add(aVal, F.mul(beta, blindingFactors[i % blindingFactors.length])),
      b: F.add(bVal, F.mul(beta, blindingFactors[(i + 1) % blindingFactors.length])),
      c: F.add(cVal, F.mul(beta, blindingFactors[(i + 2) % blindingFactors.length])),
    });
  }

  // 8. Spot-check openings
  const gamma = await transcript.squeeze();
  const numSpotChecks = Math.min(32, circuit.constraints.length);
  const spotCheckIndices = [];
  for (let i = 0; i < numSpotChecks; i++) {
    const idx = Number(F.mod(F.add(gamma, BigInt(i))) % BigInt(circuit.constraints.length));
    if (!spotCheckIndices.includes(idx)) spotCheckIndices.push(idx);
  }

  const spotChecks = [];
  for (const ci of spotCheckIndices) {
    const con = circuit.constraints[ci];
    const openedSignals = new Set();
    for (const idx of Object.keys(con.a)) openedSignals.add(parseInt(idx));
    for (const idx of Object.keys(con.b)) openedSignals.add(parseInt(idx));
    for (const idx of Object.keys(con.c)) openedSignals.add(parseInt(idx));

    const openings = {};
    for (const sigIdx of openedSignals) {
      openings[sigIdx] = {
        value: witness[sigIdx],
        proof: witnessTree.proof(sigIdx),
      };
    }
    spotChecks.push({ constraintIndex: ci, openings });
  }

  const t1 = (typeof performance !== 'undefined') ? performance.now() : Date.now();
  const proveTime = t1 - t0;

  return {
    protocol: 'unigroth-v1',
    curve: 'bn254',
    witnessCommitment: bytesToHex(witnessRoot),
    blindingCommitment: bytesToHex(blindRoot),
    aggregatedCheck: T.toString(),
    blindedEvals: blindedEvals.map(e => ({
      a: e.a.toString(), b: e.b.toString(), c: e.c.toString()
    })),
    spotChecks: spotChecks.map(sc => ({
      constraintIndex: sc.constraintIndex,
      openings: Object.fromEntries(
        Object.entries(sc.openings).map(([k, v]) => [
          k,
          {
            value: v.value.toString(),
            proof: v.proof.map(p => ({ hash: bytesToHex(p.hash), position: p.position })),
          }
        ])
      ),
    })),
    publicInputs,
    metadata: {
      circuit: circuit.name,
      constraints: circuit.constraints.length,
      signals: circuit.nSignals,
      spotChecks: spotCheckIndices.length,
      proveTimeMs: Math.round(proveTime * 100) / 100,
    },
  };
}
