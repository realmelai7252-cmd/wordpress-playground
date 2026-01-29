import type { PHPRequest, PHPResponse, RemoteAPI } from '@php-wasm/universal';
import type { PlaygroundCliBlueprintV1Worker as PlaygroundCliWorkerV1 } from './blueprints-v1/worker-thread-v1';
import type { PlaygroundCliBlueprintV2Worker as PlaygroundCliWorkerV2 } from './blueprints-v2/worker-thread-v2';

type PlaygroundCliWorker = PlaygroundCliWorkerV1 | PlaygroundCliWorkerV2;

// TODO: Let's merge worker management into PHPProcessManager
// when we can have multiple workers in both CLI and web.
// ¡ATTENTION!:Please don't expand upon this as an independent abstraction.
// NOTE: From Brandon: ^Do you still think this, Adam Ziel? I think they may be separate

// TODO: Could we just spawn a worker using the factory function to PHPProcessManager?

type Worker = RemoteAPI<PlaygroundCliWorker>;
type InProgressRequest = {
	request: PHPRequest;
	promisedResponse: Promise<PHPResponse>;
};
type QueuedRequest = {
	request: PHPRequest;
	resolve: (response: PHPResponse | PromiseLike<PHPResponse>) => void;
	reject: (reason?: any) => void;
};
export class LoadBalancer {
	// NOTE: This is just a list of the workers we think we have,
	// for visibility when debugging. The bookkeeping for load balancing
	// is done using separate collections of free and busy workers.
	workers: Worker[] = [];

	// Workers ready to work.
	freeWorkers: Worker[] = [];

	// Workers that are working.
	busyWorkers = new Map<Worker, InProgressRequest>();

	// Requests waiting for a worker.
	queuedRequests: QueuedRequest[] = [];

	constructor(workers: RemoteAPI<PlaygroundCliWorker>[]) {
		this.workers.push(...workers);
		this.freeWorkers.push(...workers);
	}

	async handleRequest(request: PHPRequest): Promise<PHPResponse> {
		const promisedResponse = new Promise<PHPResponse>((resolve, reject) => {
			this.queuedRequests.push({
				request,
				resolve,
				reject,
			});
		});
		this.serviceQueue();
		return promisedResponse;
	}

	// TODO: Improve name
	private serviceQueue() {
		while (this.queuedRequests.length > 0 && this.freeWorkers.length > 0) {
			const { request, resolve, reject } = this.queuedRequests.shift()!;
			const worker = this.freeWorkers.shift()!;

			const promisedResponse = worker.request(request).finally(() => {
				this.busyWorkers.delete(worker);
				this.freeWorkers.push(worker);

				this.serviceQueue();
			});

			promisedResponse.then(resolve, reject);

			this.busyWorkers.set(worker, {
				request,
				promisedResponse,
			});
		}
	}
}
