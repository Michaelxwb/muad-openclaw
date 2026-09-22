package test

import (
	"net/http"
	"strings"
	"testing"
)

// S-B02 [integration] 真实边界：真实 HTTP 路由/handler、真实 SQLite store、
// 真实 enqueueModelReconcile → Pod config generation 前移。三者均不 mock。
func TestLLMModels_SupportsImagesRoundTrip(t *testing.T) {
	e := newTestEnv(t)
	createPodThroughAPI(t, e, testPodBody)
	baseURL, _ := recordingLLM(t)

	// 创建时未传 supportsImages → 默认 false（注意与 supportsTools 默认 true 相反）。
	body := `{"models":[{"displayName":"Img Model","provider":"deepseek","baseUrl":"` + baseURL +
		`","apiKey":"sk-img","model":"deepseek-flash"}]}`
	rr := e.do(http.MethodPost, "/api/v1/llm/models/batch", body)
	assertStatus(t, rr, http.StatusCreated)
	if !strings.Contains(rr.Body.String(), `"supportsImages":false`) {
		t.Fatalf("创建默认应为 supportsImages:false, got: %s", rr.Body.String())
	}
	if !strings.Contains(rr.Body.String(), `"supportsTools":true`) {
		t.Fatalf("supportsTools 默认 true 不应被本改动影响, got: %s", rr.Body.String())
	}
	created := decodeAPIData[struct {
		Items []struct {
			ModelConfigID string `json:"modelConfigId"`
		} `json:"items"`
	}](t, rr.Body.Bytes())
	modelID := created.Items[0].ModelConfigID

	// 绑定一个 Human User，使后续 PATCH 真正触发 pod generation 前移。
	createBody := `{"displayName":"Img","agentId":"img","modelConfigId":"` + modelID +
		`","identity":{"channel":"wecom","externalId":"img-id","externalIdType":"corp_userid"}}`
	assertStatus(t, e.do(http.MethodPost, "/api/v1/containers/pod-a/human-users", createBody), http.StatusCreated)
	before, err := e.store.GetPod("pod-a")
	if err != nil {
		t.Fatalf("get pod before: %v", err)
	}

	// 打开图片能力。
	rr = e.do(http.MethodPatch, "/api/v1/llm/models/"+modelID, `{"supportsImages":true}`)
	assertStatus(t, rr, http.StatusOK)
	if !strings.Contains(rr.Body.String(), `"supportsImages":true`) {
		t.Fatalf("PATCH 响应应回显 supportsImages:true, got: %s", rr.Body.String())
	}

	// 列表回读一致。
	rr = e.do(http.MethodGet, "/api/v1/llm/models", "")
	assertStatus(t, rr, http.StatusOK)
	if !strings.Contains(rr.Body.String(), `"supportsImages":true`) {
		t.Fatalf("GET 列表应回读 supportsImages:true, got: %s", rr.Body.String())
	}

	// enqueueModelReconcile 必须已前移 pod config generation。
	after, err := e.store.GetPod("pod-a")
	if err != nil {
		t.Fatalf("get pod after: %v", err)
	}
	if after.ConfigGeneration != before.ConfigGeneration+1 {
		t.Fatalf("能力更新应前移 generation: before=%d after=%d", before.ConfigGeneration, after.ConfigGeneration)
	}
}

// E-B04 [integration] PATCH 未携带 supportsImages（*bool 为 nil）时，SQL 不得
// 触碰该列——否则仅轮换 apiKey 就会把已开启的图片能力隐式关掉。
func TestLLMModels_PatchWithoutSupportsImagesKeepsExistingValue(t *testing.T) {
	e := newTestEnv(t)
	createPodThroughAPI(t, e, testPodBody)
	baseURL, _ := recordingLLM(t)

	body := `{"models":[{"displayName":"Keep Model","provider":"deepseek","baseUrl":"` + baseURL +
		`","apiKey":"sk-keep","model":"deepseek-flash","supportsImages":true}]}`
	rr := e.do(http.MethodPost, "/api/v1/llm/models/batch", body)
	assertStatus(t, rr, http.StatusCreated)
	if !strings.Contains(rr.Body.String(), `"supportsImages":true`) {
		t.Fatalf("显式传 supportsImages:true 应被接受, got: %s", rr.Body.String())
	}
	created := decodeAPIData[struct {
		Items []struct {
			ModelConfigID string `json:"modelConfigId"`
		} `json:"items"`
	}](t, rr.Body.Bytes())
	modelID := created.Items[0].ModelConfigID

	// 仅轮换 apiKey：supportsImages 必须保持 true。
	rr = e.do(http.MethodPatch, "/api/v1/llm/models/"+modelID, `{"apiKey":"sk-rotated"}`)
	assertStatus(t, rr, http.StatusOK)
	if !strings.Contains(rr.Body.String(), `"supportsImages":true`) {
		t.Fatalf("仅改 apiKey 不应重置 supportsImages, got: %s", rr.Body.String())
	}
	rr = e.do(http.MethodGet, "/api/v1/llm/models", "")
	assertStatus(t, rr, http.StatusOK)
	if !strings.Contains(rr.Body.String(), `"supportsImages":true`) {
		t.Fatalf("GET 回读应保持 supportsImages:true, got: %s", rr.Body.String())
	}
}
