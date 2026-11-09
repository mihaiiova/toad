import { cliAssertion, cliDisplay, validCliPayload } from '../agent/tools/toad-cli-recording.mjs';

import { apiDescription, validApiPayload } from '../agent/tools/toad-api-recording.mjs';
import { webDescription, webPayloadUnder } from '../agent/tools/toad-web-recording.mjs';

/** Built-in codecs only. Literal command data is trusted, non-secret test data. */
export const RECORDING_CODECS = Object.freeze({
  // Every navigation stays under the handoff's URL; no credentials at all.
  'web-scenario-v1': Object.freeze({
    validate(payload, { handoff }) {
      return handoff.kind === 'web' && !Object.keys(handoff.credentials ?? {}).length &&
        typeof handoff.target?.url === 'string' && webPayloadUnder(payload, handoff.target.url);
    },
    describe: webDescription,
  }),
  'api-request-v1': Object.freeze({
    validate(payload, { handoff }) {
      return handoff.kind === 'api' && !Object.keys(handoff.credentials ?? {}).length &&
        !handoff.allow_installs && !handoff.target?.setup?.length && !handoff.target?.path?.length && validApiPayload(payload);
    },
    describe: apiDescription,
  }),
  'cli-command-v1': Object.freeze({
    validate(payload, { handoff }) {
      return handoff.kind === 'cli' && !Object.keys(handoff.credentials ?? {}).length &&
        !handoff.allow_installs && !handoff.target?.setup?.length && !handoff.target?.path?.length && validCliPayload(payload);
    },
    describe(payload) {
      return [{ action: cliDisplay(payload), assertion: cliAssertion(payload) }];
    },
  }),
});
