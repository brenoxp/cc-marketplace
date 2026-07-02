export interface SearchArgs {
  query: string;
  wait_for_complete?: boolean;
  save_to_file?: string;
  return_text?: boolean;
}

export interface SearchResults {
  answer: string;
  url: string;
}
