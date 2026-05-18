// UniGroth verifier — verifies zero-knowledge proofs
// Browser ESM port: async (Web Crypto inside).
// Source: github.com/MeridianAlgo/UniGroth/blob/main/src/verifier.js (ISC)

import * as F from './field.js';
import { MerkleTree, Transcript, hexToBytes } from './commitment.js';

export async function verify(circuit, proof) {
  const t0 = (typeof performance !== 'undefined') ? performance.now() : Date.now();
  const results = { checks: [], passed: true };

  // 1. Parse commitments
  const witnessRoot = hexToBytes(proof.witnessCommitment);
  const blindRoot   = hexToBytes(proof.blindingCommitment);

  // 2. Rebuild fiat-shamir transcript (must match prover)
  const transcript = await Transcript.create('unigroth_prove_v1');
  await transcript.absorbBytes(witnessRoot);
  await transcript.absorbBytes(blindRoot);

  for (const pi of circuit.publicInputs) {
    const pubVal = proof.publicInputs[pi.name];
    if (pubVal === undefined) {
      results.checks.push({ name: 'public_input', passed: false, detail: `missing: ${pi.name}` });
      results.passed = false;
      return results;
    }
    await transcript.absorb(BigInt(pubVal));
  }

  // 3. Derive challenges
  const alpha = await transcript.squeeze();
  const beta  = await transcript.squeeze();
  const gamma = await transcript.squeeze();

  // 4. Aggregated constraint check: T must equal 0
  const aggCheck = BigInt(proof.aggregatedCheck);
  const aggPassed = F.eq(aggCheck, 0n);
  results.checks.push({
    name: 'aggregated_constraint_check',
    passed: aggPassed,
    detail: aggPassed ? 'T = 0 (all constraints satisfied)' : `T = ${aggCheck} (FAILED)`,
  });
  if (!aggPassed) results.passed = false;

  // 5. Spot-check merkle openings + constraint evaluations
  let spotChecksPassed = 0;
  for (const sc of proof.spotChecks) {
    const con = circuit.constraints[sc.constraintIndex];
    if (!con) {
      results.checks.push({ name: `spot_check_${sc.constraintIndex}`, passed: false, detail: 'invalid constraint index' });
      results.passed = false;
      continue;
    }

    let allOpeningsValid = true;
    const openedValues = {};

    for (const [sigIdx, opening] of Object.entries(sc.openings)) {
      const val = BigInt(opening.value);
      const merkleProof = opening.proof.map(p => ({
        hash: hexToBytes(p.hash),
        position: p.position,
      }));

      const valid = await MerkleTree.verify(val, merkleProof, witnessRoot);
      if (!valid) {
        allOpeningsValid = false;
        results.checks.push({
          name: `merkle_opening_${sigIdx}`,
          passed: false,
          detail: `signal ${sigIdx} merkle proof invalid`,
        });
        results.passed = false;
      }
      openedValues[parseInt(sigIdx)] = val;
    }

    if (allOpeningsValid) {
      let aVal = 0n, bVal = 0n, cVal = 0n;
      for (const [idx, coeff] of Object.entries(con.a)) {
        const i = parseInt(idx);
        if (openedValues[i] !== undefined) {
          aVal = F.add(aVal, F.mul(coeff, openedValues[i]));
        }
      }
      for (const [idx, coeff] of Object.entries(con.b)) {
        const i = parseInt(idx);
        if (openedValues[i] !== undefined) {
          bVal = F.add(bVal, F.mul(coeff, openedValues[i]));
        }
      }
      for (const [idx, coeff] of Object.entries(con.c)) {
        const i = parseInt(idx);
        if (openedValues[i] !== undefined) {
          cVal = F.add(cVal, F.mul(coeff, openedValues[i]));
        }
      }

      const constraintSatisfied = F.eq(F.mul(aVal, bVal), cVal);
      results.checks.push({
        name: `constraint_${sc.constraintIndex}`,
        passed: constraintSatisfied,
        detail: constraintSatisfied ? 'OK' : `${F.mul(aVal, bVal)} != ${cVal}`,
      });
      if (!constraintSatisfied) results.passed = false;
      else spotChecksPassed++;
    }
  }

  results.checks.push({
    name: 'spot_checks_summary',
    passed: spotChecksPassed === proof.spotChecks.length,
    detail: `${spotChecksPassed}/${proof.spotChecks.length} spot checks passed`,
  });

  // 6. Public input consistency (presence only — value binding handled by transcript)
  for (const pi of circuit.publicInputs) {
    const claimed = BigInt(proof.publicInputs[pi.name]);
    results.checks.push({
      name: `public_input_${pi.name}`,
      passed: true,
      detail: `value present`,
    });
  }

  const t1 = (typeof performance !== 'undefined') ? performance.now() : Date.now();
  results.verifyTimeMs = Math.round((t1 - t0) * 100) / 100;

  return results;
}
