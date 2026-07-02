export interface SearchArgs {
  query: string;
  wait_for_complete?: boolean;
  save_to_file?: string;
  return_text?: boolean;
}

export interface SearchResults {
  answer: string;
  url: string;
  // undefined when auth state wasn't probed (e.g. the answer failed to render);
  // false only when the AI Mode page positively showed a signed-out surface.
  authenticated?: boolean;
}
