package runtimeconfig

import (
	"reflect"
	"testing"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
)

// copyStrings 必须保证返回非 nil 切片：validateRuntimeAgents 要求
// agent.Skills != nil，而 append([]string(nil), 空values...) 会返回 nil，
// 导致无任何 effective skill 的用户 apply 失败。
func TestCopyStringsNeverNil(t *testing.T) {
	for _, tc := range []struct {
		name  string
		input []string
	}{
		{name: "nil", input: nil},
		{name: "empty", input: []string{}},
		{name: "values", input: []string{"skill-a", "skill-b"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := copyStrings(tc.input)
			if got == nil {
				t.Fatalf("copyStrings(%v) returned nil, want non-nil", tc.input)
			}
			if tc.input != nil && !reflect.DeepEqual(got, tc.input) {
				t.Fatalf("copyStrings(%v) = %v, want %v", tc.input, got, tc.input)
			}
		})
	}
}

func TestCopyStringsCopiesNotAliases(t *testing.T) {
	source := []string{"skill-a"}
	got := copyStrings(source)
	source[0] = "mutated"
	if got[0] != "skill-a" {
		t.Fatalf("copyStrings aliased the source slice: got[0] = %q", got[0])
	}
}

func TestBuildModelsCarriesSupportsTools(t *testing.T) {
	builder := &Builder{}
	data := sourceData{
		models: []repo.LLMModelConfig{{
			ModelConfigID: "m1", DisplayName: "omni", Provider: "vllm",
			BaseURL: "http://10.0.0.1:8000", APIKey: "k", Model: "omni-model",
			SupportsTools: false,
		}},
	}
	users := []repo.HumanUser{{AgentID: "alice", ModelConfigID: "m1"}}
	providers, models, err := builder.buildModels(data, users)
	if err != nil {
		t.Fatalf("buildModels: %v", err)
	}
	if len(providers) != 1 || providers[0].SupportsTools == nil || *providers[0].SupportsTools {
		t.Fatalf("provider supportsTools = %v, want &false: %+v", providers[0].SupportsTools, providers)
	}
	if models["alice"] == "" {
		t.Fatalf("agent model ref missing: %v", models)
	}
}

func TestBuildModelsOmitsSupportsToolsWhenSupported(t *testing.T) {
	builder := &Builder{}
	data := sourceData{
		models: []repo.LLMModelConfig{{
			ModelConfigID: "m1", DisplayName: "omni", Provider: "vllm",
			BaseURL: "http://10.0.0.1:8000", APIKey: "k", Model: "omni-model",
			SupportsTools: true,
		}},
	}
	users := []repo.HumanUser{{AgentID: "alice", ModelConfigID: "m1"}}
	providers, _, err := builder.buildModels(data, users)
	if err != nil {
		t.Fatalf("buildModels: %v", err)
	}
	// 默认支持工具调用时字段省略（nil），旧 worker 镜像 schema 不认识 supportsTools
	// 也能通过 apply；renderer 对 nil/缺省按支持工具处理。
	if len(providers) != 1 || providers[0].SupportsTools != nil {
		t.Fatalf("provider supportsTools = %v, want nil (omitted): %+v", providers[0].SupportsTools, providers)
	}
}
