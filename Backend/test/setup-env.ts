import { basename } from 'path';

// Runs before every test file's own code (package.json → jest.setupFilesAfterEnv), once per file.
//
// Gives every BullMQ queue a Redis key prefix unique to THIS test file.
//
// - Separate from the dev server ('bull'): otherwise a locally running dev server's workers
//   pick up test jobs and vice versa. For document jobs that caused stale-job collisions
//   (Phase 12); for email it would mean the dev server delivering test invitations through real
//   SMTP to made-up addresses, and bounces damage the sending account's reputation.
// - Separate per file, not one shared 'bull-test': every test file boots the whole app, workers
//   included. If one file's app outlives its tests (a hung close after a failure), its workers
//   would go on consuming the NEXT file's jobs — an email captured by a sender that nobody is
//   watching. Deterministic (the file name, not a random id) so the set of keys stays bounded.
const testFile = basename(expect.getState().testPath ?? 'unknown', '.spec.ts');
process.env.QUEUE_PREFIX = `bull-test-${testFile}`;
