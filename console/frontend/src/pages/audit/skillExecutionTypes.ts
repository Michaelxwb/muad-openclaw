import type { SkillEntryType, SkillExecution, SkillExecutionStatus, SkillScope } from "../../api";

export interface SkillExecutionFilters {
  q: string;
  status: SkillExecutionStatus | "";
  scope: SkillScope | "";
  entryType: SkillEntryType | "";
  startedFrom: string;
  startedTo: string;
}

export const EMPTY_SKILL_EXECUTION_FILTERS: SkillExecutionFilters = {
  q: "",
  status: "",
  scope: "",
  entryType: "",
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
  reset: () => void;
  refresh: (background?: boolean) => Promise<void>;
}
