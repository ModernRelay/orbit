/**
 * Client-bundle exclusion fixture: a browser consumer that imports
 * only the export loader from the omnigraph adapter's root entry. Bundled by
 * scripts/pack-smoke.mjs against the packed tarballs; the resulting bundle
 * must NOT contain 'createOmnigraphServerClient' — the server-only entry
 * (`@modernrelay/orbit-omnigraph/server`, the ONLY authenticated client
 * construction) must never reach a client bundle.
 */
import { createOmnigraphSource } from '@modernrelay/orbit-omnigraph';

// Reference the import so it survives bundling.
console.log(typeof createOmnigraphSource);
