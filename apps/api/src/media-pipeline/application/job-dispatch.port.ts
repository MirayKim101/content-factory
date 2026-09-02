export const JOB_DISPATCH = Symbol("JOB_DISPATCH");

export interface JobDelivery {
  jobId: string;
  attemptNumber: number;
}

export interface JobDispatch {
  dispatch(delivery: JobDelivery): Promise<void>;
}
