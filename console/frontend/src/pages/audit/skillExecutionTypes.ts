import type { SkillExecution, SkillScope } from "../../api";

export interface SkillExecutionFilters {
  q: string;
  scope: SkillScope | "";
  startedFrom: string;
  startedTo: string;
}

export const EMPTY_SKILL_EXECUTION_FILTERS: SkillExecutionFilters = {
  q: "",
  scope: "",
  startedFrom: "",
  startedTo: "",
};

export interface SkillExecutionRecordsState {
  rows: SkillExecution[];
  total: number;
  loading: boolean;
  error: string;
  page: number;
  pageSize: number;
  draftFilters: SkillExecutionFilters;
  setDraftFilters: (filters: SkillExecutionFilters) => void;
  setPage: (page: number) => void;
  setPageSize: (pageSize: number) => void;
  search: () => void;
  applyFilter: (patch: Partial<SkillExecutionFilters>) => void;
  reset: () => void;
  refresh: (background?: boolean) => Promise<void>;
}
