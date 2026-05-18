// UniGroth circuit builder — define ZK circuits in pure JavaScript
// Browser ESM port. Circuit operations are sync (field arithmetic only).
// MIMC round constants are precomputed at module load via top-level await.
// Source: github.com/MeridianAlgo/UniGroth/blob/main/src/circuit.js (ISC)

import * as F from './field.js';
import { sha256 } from './commitment.js';

const enc = new TextEncoder();
export const MIMC_ROUNDS = 91;

async function _precomputeMimcConstants() {
  const consts = [];
  for (let i = 0; i < MIMC_ROUNDS; i++) {
    const digest = await sha256(enc.encode(`unigroth_mimc_${i}`));
    let val = 0n;
    for (const b of digest) val = (val << 8n) | BigInt(b);
    consts.push(F.mod(val));
  }
  return consts;
}

// Top-level await: blocks module-load until 91 SHA-256 hashes finish (~1-5 ms cold).
// After this, Circuit.hash() can use MIMC_CONSTANTS synchronously.
export const MIMC_CONSTANTS = await _precomputeMimcConstants();

export class Circuit {
  constructor(name = 'circuit') {
    this.name = name;
    this.nSignals = 0;
    this.constraints = [];
    this.publicInputs = [];
    this.privateInputs = [];
    this.signalNames = [];
    this.signalMap = {};

    // signal 0 is always constant 1
    this._alloc('__one');
  }

  _alloc(name) {
    const idx = this.nSignals++;
    this.signalNames.push(name);
    this.signalMap[name] = idx;
    return idx;
  }

  publicInput(name) {
    const idx = this._alloc(name);
    this.publicInputs.push({ name, index: idx });
    return idx;
  }

  privateInput(name) {
    const idx = this._alloc(name);
    this.privateInputs.push({ name, index: idx });
    return idx;
  }

  // R1CS constraint: (a·w) * (b·w) = (c·w)
  _addConstraint(a, b, c) {
    this.constraints.push({ a, b, c });
  }

  add(x, y) {
    const out = this._alloc(`add_${this.nSignals}`);
    this._addConstraint({ [x]: 1n, [y]: 1n }, { 0: 1n }, { [out]: 1n });
    return out;
  }

  sub(x, y) {
    const out = this._alloc(`sub_${this.nSignals}`);
    this._addConstraint({ [x]: 1n, [y]: F.ORDER - 1n }, { 0: 1n }, { [out]: 1n });
    return out;
  }

  mul(x, y) {
    const out = this._alloc(`mul_${this.nSignals}`);
    this._addConstraint({ [x]: 1n }, { [y]: 1n }, { [out]: 1n });
    return out;
  }

  addConst(x, constant) {
    const c = F.toBigInt(constant);
    const out = this._alloc(`addc_${this.nSignals}`);
    this._addConstraint({ [x]: 1n, 0: c }, { 0: 1n }, { [out]: 1n });
    return out;
  }

  mulConst(x, constant) {
    const c = F.toBigInt(constant);
    const out = this._alloc(`mulc_${this.nSignals}`);
    this._addConstraint({ [x]: c }, { 0: 1n }, { [out]: 1n });
    return out;
  }

  assertEqual(x, y) {
    this._addConstraint({ [x]: 1n }, { 0: 1n }, { [y]: 1n });
  }

  cube(x) {
    const sq = this.mul(x, x);
    const cu = this.mul(sq, x);
    return cu;
  }

  // MIMC hash (91 rounds, ~128-bit security on bn254)
  hash(input) {
    let x = input;
    for (let i = 0; i < MIMC_ROUNDS; i++) {
      x = this.addConst(x, MIMC_CONSTANTS[i]);
      x = this.cube(x);
    }
    return x;
  }

  computeWitness(inputs) {
    const w = new Array(this.nSignals);
    const set = new Array(this.nSignals).fill(false);

    w[0] = 1n; set[0] = true;

    for (const { name, index } of this.publicInputs) {
      if (inputs[name] === undefined) throw new Error(`missing public input: ${name}`);
      w[index] = F.toBigInt(inputs[name]);
      set[index] = true;
    }

    for (const { name, index } of this.privateInputs) {
      if (inputs[name] === undefined) throw new Error(`missing private input: ${name}`);
      w[index] = F.toBigInt(inputs[name]);
      set[index] = true;
    }

    for (const con of this.constraints) {
      const aVal = this._evalLC(con.a, w);
      const bVal = this._evalLC(con.b, w);
      const product = F.mul(aVal, bVal);

      let known = 0n;
      let unknownIdx = -1;
      let unknownCoeff = 0n;

      for (const [idx, coeff] of Object.entries(con.c)) {
        const i = parseInt(idx);
        if (set[i]) {
          known = F.add(known, F.mul(coeff, w[i]));
        } else {
          unknownIdx = i;
          unknownCoeff = coeff;
        }
      }

      if (unknownIdx >= 0 && unknownCoeff !== 0n) {
        w[unknownIdx] = F.div(F.sub(product, known), unknownCoeff);
        set[unknownIdx] = true;
      }
    }

    return w;
  }

  _evalLC(lc, w) {
    let sum = 0n;
    for (const [idx, coeff] of Object.entries(lc)) {
      sum = F.add(sum, F.mul(coeff, w[parseInt(idx)]));
    }
    return sum;
  }

  checkWitness(w) {
    for (let i = 0; i < this.constraints.length; i++) {
      const con = this.constraints[i];
      const aVal = this._evalLC(con.a, w);
      const bVal = this._evalLC(con.b, w);
      const cVal = this._evalLC(con.c, w);
      if (!F.eq(F.mul(aVal, bVal), cVal)) {
        return { valid: false, failedConstraint: i };
      }
    }
    return { valid: true };
  }

  stats() {
    return {
      name: this.name,
      signals: this.nSignals,
      constraints: this.constraints.length,
      publicInputs: this.publicInputs.length,
      privateInputs: this.privateInputs.length,
    };
  }
}
