import { describe, expect, it } from 'vitest';
import { createRingBuffer } from '../../src/main/ringBuffer.js';

describe('createRingBuffer', () => {
  it('keeps lines in insertion order below capacity', () => {
    const rb = createRingBuffer(3);
    rb.push('a');
    rb.push('b');
    expect(rb.lines()).toEqual(['a', 'b']);
    expect(rb.size()).toBe(2);
  });

  it('keeps the newest lines on overflow', () => {
    const rb = createRingBuffer(3);
    for (const l of ['a', 'b', 'c', 'd', 'e']) rb.push(l);
    expect(rb.lines()).toEqual(['c', 'd', 'e']);
    expect(rb.size()).toBe(3);
  });

  it('tail(n) returns the newest n lines oldest-first', () => {
    const rb = createRingBuffer(4);
    for (const l of ['a', 'b', 'c', 'd', 'e', 'f']) rb.push(l);
    expect(rb.tail(2)).toEqual(['e', 'f']);
    expect(rb.tail(4)).toEqual(['c', 'd', 'e', 'f']);
    expect(rb.tail(99)).toEqual(['c', 'd', 'e', 'f']);
    expect(rb.tail(0)).toEqual([]);
  });

  it('clear empties the buffer and it can be reused', () => {
    const rb = createRingBuffer(2);
    rb.push('a');
    rb.push('b');
    rb.push('c');
    rb.clear();
    expect(rb.size()).toBe(0);
    expect(rb.lines()).toEqual([]);
    rb.push('x');
    expect(rb.lines()).toEqual(['x']);
  });

  it('defaults to a capacity of 500', () => {
    const rb = createRingBuffer();
    for (let i = 0; i < 700; i++) rb.push(String(i));
    expect(rb.size()).toBe(500);
    expect(rb.lines()[0]).toBe('200');
    expect(rb.tail(1)).toEqual(['699']);
  });

  it('rejects invalid capacities', () => {
    expect(() => createRingBuffer(0)).toThrow(RangeError);
    expect(() => createRingBuffer(1.5)).toThrow(RangeError);
  });

  it('returned arrays are copies', () => {
    const rb = createRingBuffer(2);
    rb.push('a');
    rb.lines().push('zzz');
    expect(rb.lines()).toEqual(['a']);
  });
});
