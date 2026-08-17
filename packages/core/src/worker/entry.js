// Shared bootstrap for workspace Vite builds and the published worker asset.
// The implementation stays in TypeScript so the real thread and test double
// continue to share the same runtime/codec.
import { installWorkerEntry } from './entry.ts';

installWorkerEntry(self);
