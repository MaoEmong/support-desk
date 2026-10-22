/** Test-only transient fault injection around the REAL API composition. */
import { createWorkerDependencies as createRealWorkerDependencies } from '../../../apps/web/src/server/ai/worker-bootstrap';
import { ProcessorFailure } from '../../queue/src/index';

export async function createWorkerDependencies() {
  const deps = await createRealWorkerDependencies();
  return {
    ...deps,
    processInquiry: async (input: Parameters<typeof deps.processInquiry>[0]) => {
      if (input.ticketId === process.env.WINDOW1_FAILURE_TICKET) throw new ProcessorFailure('window1_transient');
      return deps.processInquiry(input);
    },
  };
}
