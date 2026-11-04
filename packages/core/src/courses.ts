/**
 * courses.ts — a restaurant's courses on a bill (owner, 2026-11-04: the web POS's courses on the desktop POS too, with
 * the online licence).
 *
 * A cart line may carry a course (Starters, Mains, Desserts, Drinks). A line given a course starts HELD: Send to kitchen
 * leaves it off the ticket until the cashier presses "Fire <course>", or the bill is paid (what is paid for always
 * reaches the kitchen). "Fires now" sends it with the rest. A line with no course is sent as it always was — an order
 * with no course is sent and printed exactly as before.
 *
 * One module in packages/core (@zaptill/core/courses), used by the desktop POS and the web POS. Pure: no imports.
 */

/** The courses offered on a line (the web POS's list since course firing). */
export const COURSES = ['Starters', 'Mains', 'Desserts', 'Drinks'] as const;

export type FireStatus = 'held' | 'fired';

export interface CourseLine {
  quantity: number;
  sentQty?: number;
  kotSent?: boolean;
  course?: string | null;
  fire_status?: FireStatus | null;
}

/** A course name as stored: one of COURSES, else none. */
export function cleanCourse(raw: unknown): string | null {
  const c = typeof raw === 'string' ? raw.trim() : '';
  return (COURSES as readonly string[]).includes(c) ? c : null;
}

/** The line given a course (held until fired, as the web POS), or none (sent with the order). */
export function withCourse<T extends CourseLine>(line: T, course: string): T {
  const c = cleanCourse(course);
  return { ...line, course: c, fire_status: c ? (line.fire_status ?? 'held') : 'fired' };
}

/** Held ↔ Fires now, for a line with a course. */
export function toggledHold<T extends CourseLine>(line: T): T {
  if (!line.course) return line;
  return { ...line, fire_status: line.fire_status === 'held' ? 'fired' : 'held' };
}

/** Is this line waiting for its course to be fired? Only with courses on (`coursesOn`: a restaurant with the licence). */
export function isHeld(line: CourseLine, coursesOn: boolean): boolean {
  return coursesOn && !!line.course && line.fire_status === 'held';
}

/** The courses with a line still held, in the menu's order. */
export function heldCourses(lines: CourseLine[], coursesOn: boolean): string[] {
  const held = new Set(lines.filter((l) => isHeld(l, coursesOn)).map((l) => l.course as string));
  return COURSES.filter((c) => held.has(c));
}

/** Fire a course: its held lines become "fires now" (the caller then sends them). */
export function firedCourse<T extends CourseLine>(lines: T[], course: string): T[] {
  return lines.map((l) => (l.course === course && l.fire_status === 'held' ? { ...l, fire_status: 'fired' as const } : l));
}
