import { resetDemo } from './demo-db';

// Leave the demo as the seed made it: tests' transfers, top-ups and chaos runs are gone.
export default function globalTeardown(): void {
  resetDemo();
}
