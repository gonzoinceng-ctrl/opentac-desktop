/** Default number of lines kept for the server log tail shown in the setup window. */
export const DEFAULT_RING_CAPACITY = 500;

/** Fixed-capacity line buffer that drops the oldest line on overflow. */
export interface RingBuffer {
  /** Appends a line in O(1), evicting the oldest when full. */
  push(line: string): void;
  /** All retained lines, oldest first. */
  lines(): string[];
  /** The newest `n` lines, oldest first. */
  tail(n: number): string[];
  /** Drops every retained line. */
  clear(): void;
  /** Number of retained lines. */
  size(): number;
}

/** Creates a ring buffer holding at most `capacity` lines (default 500). */
export function createRingBuffer(capacity: number = DEFAULT_RING_CAPACITY): RingBuffer {
  if (!Number.isInteger(capacity) || capacity < 1) {
    throw new RangeError(`Ring buffer capacity must be a positive integer, got ${capacity}`);
  }
  const slots: string[] = new Array<string>(capacity).fill('');
  let start = 0;
  let count = 0;

  function readLast(n: number): string[] {
    const take = Math.min(Math.max(0, Math.floor(n)), count);
    const out: string[] = [];
    for (let i = count - take; i < count; i++) {
      out.push(slots[(start + i) % capacity] ?? '');
    }
    return out;
  }

  return {
    push(line) {
      if (count < capacity) {
        slots[(start + count) % capacity] = line;
        count++;
      } else {
        slots[start] = line;
        start = (start + 1) % capacity;
      }
    },
    lines: () => readLast(count),
    tail: (n) => readLast(n),
    clear() {
      slots.fill('');
      start = 0;
      count = 0;
    },
    size: () => count,
  };
}
