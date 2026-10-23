import { describe, expect, it } from 'vitest'
import { isPlainObject, isStringArray } from '../src/guards.ts'

describe('isPlainObject', () => {
  it.each([
    ['an empty object', {}],
    ['an object with fields', { verdict: 'pass', checks: [] }],
  ])('accepts %s', (_label, value) => {
    expect(isPlainObject(value)).toBe(true)
  })

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an empty array', []],
    ['an array of objects', [{}]],
    ['a string', 'text'],
    ['a number', 1],
    ['a boolean', true],
  ])('rejects %s', (_label, value) => {
    expect(isPlainObject(value)).toBe(false)
  })
})

describe('isStringArray', () => {
  it.each([
    ['an empty array', []],
    ['an array of strings', ['a', 'b']],
  ])('accepts %s', (_label, value) => {
    expect(isStringArray(value)).toBe(true)
  })

  it.each([
    ['a string', 'ab'],
    ['null', null],
    ['an object', {}],
    ['an array with a number', ['a', 1]],
    ['an array with null', ['a', null]],
    ['an array with a nested array', [['a']]],
  ])('rejects %s', (_label, value) => {
    expect(isStringArray(value)).toBe(false)
  })
})
