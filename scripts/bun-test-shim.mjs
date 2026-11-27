import assert from "node:assert/strict"
import { describe, test } from "node:test"

const ASYMMETRIC_STRING = Symbol("stringContaining")

function matchValue(actual, expected) {
  if (expected && typeof expected === "object" && expected[ASYMMETRIC_STRING] !== undefined) {
    assert.equal(typeof actual, "string")
    assert.ok(actual.includes(expected[ASYMMETRIC_STRING]), `Expected ${JSON.stringify(actual)} to contain ${JSON.stringify(expected[ASYMMETRIC_STRING])}`)
    return
  }
  if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual), `Expected array, got ${typeof actual}`)
    assert.equal(actual.length, expected.length)
    for (let i = 0; i < expected.length; i++) {
      matchValue(actual[i], expected[i])
    }
    return
  }
  assert.deepEqual(actual, expected)
}

function makeMatchers(actual, negated = false) {
  const check = (cond, msg) => {
    if (negated ? cond : !cond) {
      throw new assert.AssertionError({ message: msg, actual, operator: negated ? "not" : "expect" })
    }
  }
  const matchers = {
    get not() {
      return makeMatchers(actual, !negated)
    },
    get rejects() {
      return {
        async toThrow(expected) {
          let failed = false
          let caught
          try {
            await actual
          } catch (err) {
            failed = true
            caught = err
          }
          assert.ok(failed, "Expected promise to reject")
          if (expected) {
            const msg = caught instanceof Error ? caught.message : String(caught)
            if (typeof expected === "string") assert.ok(msg.includes(expected), `Expected "${msg}" to include "${expected}"`)
            else if (expected instanceof RegExp) assert.match(msg, expected)
          }
        },
      }
    },
    toBe(expected) {
      if (negated) assert.notStrictEqual(actual, expected)
      else assert.strictEqual(actual, expected)
    },
    toEqual(expected) {
      if (negated) {
        let same = false
        try {
          matchValue(actual, expected)
          same = true
        } catch {}
        assert.ok(!same, "Expected values not to be equal")
      } else {
        matchValue(actual, expected)
      }
    },
    toContain(expected) {
      const ok = typeof actual === "string" || Array.isArray(actual) ? actual.includes(expected) : false
      check(ok, `Expected ${JSON.stringify(actual)} ${negated ? "not " : ""}to contain ${JSON.stringify(expected)}`)
    },
    toHaveLength(len) {
      check(actual?.length === len, `Expected length ${actual?.length} ${negated ? "not " : ""}to be ${len}`)
    },
    toBeGreaterThan(n) {
      check(actual > n, `Expected ${actual} ${negated ? "not " : ""}> ${n}`)
    },
    toBeLessThanOrEqual(n) {
      check(actual <= n, `Expected ${actual} ${negated ? "not " : ""}<= ${n}`)
    },
  }
  return matchers
}

export function expect(actual) {
  return makeMatchers(actual, false)
}

expect.stringContaining = (str) => ({ [ASYMMETRIC_STRING]: str })

export { describe, test }
