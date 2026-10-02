// The reply classes, in one const array (AP-03). It is the source of the
// ReplyClass type (re-exported from services/reply-classifier.ts) and of
// the class list the assistant handbook prints, so a class added or
// removed here changes both — the guide can no longer name classes that
// do not exist (I133). Kept free of imports so the handbook export
// script can load it without a database.

export const REPLY_CLASSES = [
  'positive',
  'redirect',
  'question',
  'interest',
  'doc_request',
  'negative',
  'out_of_office',
  'bounce',
  'unsubscribe',
  'irrelevant',
] as const;

export type ReplyClass = (typeof REPLY_CLASSES)[number];
