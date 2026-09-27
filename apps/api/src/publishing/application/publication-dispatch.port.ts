export const PUBLICATION_DISPATCH = Symbol("PUBLICATION_DISPATCH");

export interface PublicationDispatch {
  dispatch(input: {
    id: string;
    scheduledAt: Date;
    deliveryRevision: string;
  }): Promise<void>;
}
