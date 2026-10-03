/**
 * Conditional class names for shadcn components.
 *
 * WHY tailwind-merge: shadcn components ship default classes and are meant to be overridden by the
 * caller (`<Button className="mt-4">`). Without conflict resolution the later class loses in a way
 * that depends on stylesheet order rather than intent, which is exactly the silent divergence this
 * project avoids.
 */
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}