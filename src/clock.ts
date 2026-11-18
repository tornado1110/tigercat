export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): ClockTimer;
  clearTimeout(timer: ClockTimer): void;
}

export interface ClockTimer {
  readonly id: number;
}

export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }

  setTimeout(fn: () => void, ms: number): ClockTimer {
    const handle = setTimeout(fn, ms);
    return {
      id: Number(handle),
      clear: () => clearTimeout(handle),
    } as ClockTimer & { clear: () => void };
  }

  clearTimeout(timer: ClockTimer): void {
    const clear = (timer as ClockTimer & { clear?: () => void }).clear;
    if (clear) clear();
  }
}

interface FakeTimer {
  id: number;
  at: number;
  fn: () => void;
}

export class FakeClock implements Clock {
  private nowMs: number;
  private nextId = 1;
  private timers: FakeTimer[] = [];

  constructor(start = 0) {
    this.nowMs = start;
  }

  now(): number {
    return this.nowMs;
  }

  setTimeout(fn: () => void, ms: number): ClockTimer {
    const id = this.nextId++;
    this.timers.push({ id, at: this.nowMs + Math.max(0, ms), fn });
    return { id };
  }

  clearTimeout(timer: ClockTimer): void {
    this.timers = this.timers.filter((entry) => entry.id !== timer.id);
  }

  /**
   * Move the clock forward by `ms` and run every timer that comes due,
   * in order. Timers scheduled by a firing callback in the same instant
   * run before the clock finishes advancing.
   */
  advance(ms: number): void {
    if (ms < 0) throw new Error("FakeClock cannot go backwards");
    const target = this.nowMs + ms;
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = this.timers[0];
      if (!next || next.at > target) break;
      this.timers.shift();
      this.nowMs = next.at;
      next.fn();
    }
    this.nowMs = target;
  }

  set(ms: number): void {
    if (ms < this.nowMs) throw new Error("FakeClock cannot go backwards");
    this.advance(ms - this.nowMs);
  }

  pending(): number {
    return this.timers.length;
  }
}
