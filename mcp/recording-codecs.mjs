import { cliAssertion, cliDisplay, validCliPayload } from '../agent/tools/toad-cli-recording.mjs';

/** Built-in codecs only. Literal command data is trusted, non-secret test data. */
export const RECORDING_CODECS = Object.freeze({
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
