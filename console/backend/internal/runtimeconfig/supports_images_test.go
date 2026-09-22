package runtimeconfig

import (
	"encoding/json"
	"strings"
	"testing"
)

// S-B04 [unit] 真实边界：runtimeProvider 的真实构建逻辑 + 真实 encoding/json
// 序列化。断言的是最终 DTO 的 JSON 形态——旧 worker 镜像能否 apply 取决于它。
func TestRuntimeProviderSupportsImagesSerialization(t *testing.T) {
	base := modelConfig{
		Provider: "deepseek", BaseURL: "https://api.deepseek.com",
		APIKey: "sk-x", Model: "deepseek-flash", SupportsTools: true, Thinking: "off",
	}

	// true：必须显式输出，这是 renderer 写出 input:["text","image"] 的唯一来源。
	enabled := base
	enabled.SupportsImages = true
	provider, _, err := runtimeProvider("agent", "u1", enabled)
	if err != nil {
		t.Fatalf("runtimeProvider(enabled): %v", err)
	}
	raw, err := json.Marshal(provider)
	if err != nil {
		t.Fatalf("marshal(enabled): %v", err)
	}
	if !strings.Contains(string(raw), `"supportsImages":true`) {
		t.Fatalf("true 时应输出 supportsImages:true, got: %s", raw)
	}

	// false / 缺省：字段必须整体消失，保证存量配置字节不变、旧 worker 可 apply。
	// 注意方向与 supportsTools 相反：后者是 false 时输出。
	for name, model := range map[string]modelConfig{
		"false":   func() modelConfig { m := base; m.SupportsImages = false; return m }(),
		"omitted": base,
	} {
		provider, _, err := runtimeProvider("agent", "u1", model)
		if err != nil {
			t.Fatalf("runtimeProvider(%s): %v", name, err)
		}
		raw, err := json.Marshal(provider)
		if err != nil {
			t.Fatalf("marshal(%s): %v", name, err)
		}
		if strings.Contains(string(raw), "supportsImages") {
			t.Fatalf("%s 时字段不应出现（旧 worker 兼容）, got: %s", name, raw)
		}
	}
}
