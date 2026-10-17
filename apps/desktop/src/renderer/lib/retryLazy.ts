/**
 * retryLazy.ts — A519 (A517 follow-up): a React.lazy screen that can be loaded again.
 *
 * React.lazy keeps its first answer for ever: a chunk that failed to load once (a damaged or missing file after a bad
 * update, a disk hiccup) rethrows on every render after it, so "Retry" could never work. `retryLazy` is React.lazy with
 * one difference — after a failure, `resetFailedScreens()` gives the screen a fresh React.lazy, so the next render
 * imports the chunk again. A screen that loaded is never reset.
 *
 * Pure apart from React, so the tests run it.
 */
import { lazy as reactLazy, createElement, type ComponentType } from 'react';

type Loader<P> = () => Promise<{ default: ComponentType<P> }>;

const resets = new Set<() => boolean>();

/** React.lazy that can be re-imported after a failed load (resetFailedScreens). */
export function retryLazy<P extends object>(load: Loader<P>): ComponentType<P> {
  let failed = false;
  const make = () => reactLazy(() => load().catch((e: unknown) => { failed = true; throw e; }));
  let current = make();
  resets.add(() => { if (!failed) return false; failed = false; current = make(); return true; });
  const Screen = (props: P) => createElement(current as unknown as ComponentType<P>, props);
  return Screen;
}

/** Every screen whose chunk failed gets a fresh import at its next render. Returns how many were reset. */
export function resetFailedScreens(): number {
  let n = 0;
  for (const r of resets) if (r()) n++;
  return n;
}
