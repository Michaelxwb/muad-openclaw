package repo

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	secretcrypto "github.com/Michaelxwb/muad-openclaw/console/backend/internal/crypto"
)

type EffectiveSkillFilter struct {
	Query  string
	Status string
}

type skillPolicySet struct {
	Disable       bool
	AllowOverride bool
}

type skillGroup struct {
	System  *SkillAsset
	Public  *SkillAsset
	Private *SkillAsset
}

// ResolveEffectiveSkills returns the per-Human User Skill state used by the
// administrator view and runtime policy generation.
func (s *Store) ResolveEffectiveSkills(
	cipher *secretcrypto.Cipher, humanUserID string, filter EffectiveSkillFilter,
) ([]EffectiveSkill, int, error) {
	user, err := s.GetHumanUser(humanUserID)
	if err != nil {
		return nil, 0, err
	}
	assets, err := s.listAssetsForEffectiveResolver(user.HumanUserID)
	if err != nil {
		return nil, 0, err
	}
	context, err := s.effectiveSkillContext(cipher, user)
	if err != nil {
		return nil, 0, err
	}
	skills, err := buildEffectiveSkills(assets, context)
	if err != nil {
		return nil, 0, err
	}
	filtered := filterEffectiveSkills(skills, filter)
	return filtered, len(filtered), nil
}

type effectiveSkillContext struct {
	Policies       map[string]skillPolicySet
	Platforms      map[string]PlatformConfig
	Credentials    map[string]struct{}
	LastExecutions map[string]SkillExecutionRecord
	RuntimePending bool
}

func (s *Store) effectiveSkillContext(
	cipher *secretcrypto.Cipher, user HumanUser,
) (effectiveSkillContext, error) {
	policies, err := s.ListSkillPoliciesByHumanUser(user.HumanUserID)
	if err != nil {
		return effectiveSkillContext{}, err
	}
	platforms, err := s.ListPlatformConfigs()
	if err != nil {
		return effectiveSkillContext{}, err
	}
	credentials, err := s.ListUserPlatformCredentials(cipher, user.HumanUserID)
	if err != nil {
		return effectiveSkillContext{}, err
	}
	last, err := s.latestSkillExecutionsByName(user.HumanUserID)
	if err != nil {
		return effectiveSkillContext{}, err
	}
	pod, err := s.GetPod(user.PodID)
	if err != nil {
		return effectiveSkillContext{}, err
	}
	return effectiveSkillContext{
		Policies:       indexSkillPolicies(policies),
		Platforms:      indexPlatformConfigs(platforms),
		Credentials:    indexCredentialSummaries(credentials),
		LastExecutions: last,
		RuntimePending: pod.LastApplyStatus != ApplyStatusApplied || pod.AppliedGeneration < pod.ConfigGeneration,
	}, nil
}

func (s *Store) listAssetsForEffectiveResolver(humanUserID string) ([]SkillAsset, error) {
	rows, err := s.db.Query(`SELECT `+skillAssetColumns+`
		FROM skill_assets
		WHERE status != 'deleted' AND (scope IN ('system','public') OR human_user_id = ?)
		ORDER BY name, scope`, humanUserID)
	if err != nil {
		return nil, fmt.Errorf("list Skill assets for resolver: %w", err)
	}
	defer rows.Close()
	return collectSkillAssets(rows)
}

func (s *Store) latestSkillExecutionsByName(
	humanUserID string,
) (map[string]SkillExecutionRecord, error) {
	rows, err := s.db.Query(`SELECT `+skillExecutionColumns+` FROM (
		SELECT `+skillExecutionColumns+`,
		ROW_NUMBER() OVER (PARTITION BY skill_name ORDER BY started_at DESC, execution_id DESC) AS rn
		FROM skill_execution_records WHERE human_user_id = ?
	) WHERE rn = 1`, humanUserID)
	if err != nil {
		return nil, fmt.Errorf("list latest Skill executions: %w", err)
	}
	defer rows.Close()
	records, err := collectSkillExecutionRecords(rows)
	if err != nil {
		return nil, err
	}
	out := make(map[string]SkillExecutionRecord, len(records))
	for _, record := range records {
		out[record.SkillName] = record
	}
	return out, nil
}

func buildEffectiveSkills(
	assets []SkillAsset, context effectiveSkillContext,
) ([]EffectiveSkill, error) {
	groups := groupSkillAssets(assets)
	skills := make([]EffectiveSkill, 0, len(groups))
	for name, group := range groups {
		skill, err := buildEffectiveSkill(name, group, context)
		if err != nil {
			return nil, err
		}
		skills = append(skills, skill)
	}
	sort.Slice(skills, func(i, j int) bool { return skills[i].Name < skills[j].Name })
	return skills, nil
}

func buildEffectiveSkill(
	name string, group skillGroup, context effectiveSkillContext,
) (EffectiveSkill, error) {
	policy := context.Policies[name]
	if group.System != nil {
		return effectiveFromAsset(*group.System, context, false, "")
	}
	if policy.Disable {
		return disabledEffectiveSkill(name, group, context), nil
	}
	if group.Private != nil && group.Public != nil && !policy.AllowOverride {
		return conflictEffectiveSkill(name, group, context)
	}
	asset := chooseEffectiveAsset(group)
	if asset == nil {
		return EffectiveSkill{Name: name, Status: EffectiveSkillStatusDisabled}, nil
	}
	return effectiveFromAsset(*asset, context, false, "")
}

func effectiveFromAsset(
	asset SkillAsset, context effectiveSkillContext, conflict bool, reason string,
) (EffectiveSkill, error) {
	platforms, missing, err := resolveSkillPlatforms(asset.PlatformsJSON, context)
	if err != nil {
		return EffectiveSkill{}, err
	}
	status := EffectiveSkillStatusEffective
	effective := asset.Status == SkillStatusActive && !missing
	if asset.Status == SkillStatusDisabled {
		status = EffectiveSkillStatusDisabled
	} else if missing {
		status = EffectiveSkillStatusMissingCredential
	}
	skill := skillFromAsset(asset, status, effective, conflict, reason)
	skill.Platforms = platforms
	skill.RuntimePending = context.RuntimePending
	if last, ok := context.LastExecutions[asset.Name]; ok {
		skill.LastExecution = &last
	}
	return skill, nil
}

func conflictEffectiveSkill(
	name string, group skillGroup, context effectiveSkillContext,
) (EffectiveSkill, error) {
	skill, err := effectiveFromAsset(*group.Public, context, true, "private_overrides_public_requires_approval")
	if err != nil {
		return EffectiveSkill{}, err
	}
	skill.Name = name
	skill.PrivateSkillID = group.Private.SkillID
	skill.PublicSkillID = group.Public.SkillID
	skill.Status = EffectiveSkillStatusConflict
	return skill, nil
}

func disabledEffectiveSkill(
	name string, group skillGroup, context effectiveSkillContext,
) EffectiveSkill {
	skill := EffectiveSkill{Name: name, Status: EffectiveSkillStatusDisabled, RuntimePending: context.RuntimePending}
	asset := chooseEffectiveAsset(group)
	if asset == nil {
		return skill
	}
	skill.DisplayName = asset.DisplayName
	skill.Version = asset.Version
	skill.EntryType = asset.EntryType
	skill.ScriptFiles = scriptFilesFromAsset(*asset)
	skill.EffectiveSource = asset.Scope
	assignSkillID(&skill, *asset)
	if last, ok := context.LastExecutions[name]; ok {
		skill.LastExecution = &last
	}
	return skill
}

func chooseEffectiveAsset(group skillGroup) *SkillAsset {
	switch {
	case group.Private != nil:
		return group.Private
	case group.Public != nil:
		return group.Public
	default:
		return group.System
	}
}

func skillFromAsset(
	asset SkillAsset, status string, effective, conflict bool, reason string,
) EffectiveSkill {
	skill := EffectiveSkill{
		Name: asset.Name, DisplayName: asset.DisplayName, Effective: effective,
		EffectiveSource: asset.Scope, Status: status, Version: asset.Version, EntryType: asset.EntryType,
		ScriptFiles:       scriptFilesFromAsset(asset),
		ProgressSupported: asset.ProgressSupported, BrowserRequired: asset.BrowserRequired,
		Conflict: conflict, ConflictReason: reason,
	}
	assignSkillID(&skill, asset)
	return skill
}

func scriptFilesFromAsset(asset SkillAsset) []string {
	var metadata struct {
		ScriptFiles []string `json:"scriptFiles"`
	}
	if json.Unmarshal([]byte(asset.ManifestJSON), &metadata) != nil {
		return []string{}
	}
	files := make([]string, 0, len(metadata.ScriptFiles))
	for _, file := range metadata.ScriptFiles {
		if value := strings.TrimSpace(file); value != "" {
			files = append(files, value)
		}
	}
	sort.Strings(files)
	return files
}

func assignSkillID(skill *EffectiveSkill, asset SkillAsset) {
	switch asset.Scope {
	case SkillScopeSystem:
		skill.SystemSkillID = asset.SkillID
	case SkillScopePublic:
		skill.PublicSkillID = asset.SkillID
	case SkillScopePrivate:
		skill.PrivateSkillID = asset.SkillID
	}
}

func groupSkillAssets(assets []SkillAsset) map[string]skillGroup {
	groups := make(map[string]skillGroup, len(assets))
	for _, asset := range assets {
		assetCopy := asset
		group := groups[asset.Name]
		switch asset.Scope {
		case SkillScopeSystem:
			group.System = &assetCopy
		case SkillScopePublic:
			group.Public = &assetCopy
		case SkillScopePrivate:
			group.Private = &assetCopy
		}
		groups[asset.Name] = group
	}
	return groups
}

func resolveSkillPlatforms(
	raw string, context effectiveSkillContext,
) ([]SkillPlatformStatus, bool, error) {
	platforms, err := parseSkillPlatformList(raw)
	if err != nil {
		return nil, false, err
	}
	statuses := make([]SkillPlatformStatus, 0, len(platforms))
	missing := false
	for _, platform := range platforms {
		status := skillPlatformStatus(platform, context)
		if status.CredentialStatus != SkillCredentialConfigured {
			missing = true
		}
		statuses = append(statuses, status)
	}
	return statuses, missing, nil
}

func skillPlatformStatus(platform string, context effectiveSkillContext) SkillPlatformStatus {
	config, exists := context.Platforms[platform]
	status := SkillPlatformStatus{Platform: platform}
	if !exists {
		status.CredentialStatus = SkillCredentialPlatformMissing
		return status
	}
	status.PlatformEnabled = config.Enabled
	if !config.Enabled {
		status.CredentialStatus = SkillCredentialPlatformDisabled
		return status
	}
	if _, configured := context.Credentials[platform]; configured {
		status.CredentialStatus = SkillCredentialConfigured
	} else {
		status.CredentialStatus = SkillCredentialMissing
	}
	return status
}

func parseSkillPlatformList(raw string) ([]string, error) {
	var platforms []string
	if err := json.Unmarshal([]byte(raw), &platforms); err != nil {
		return nil, fmt.Errorf("decode Skill platforms: %w", err)
	}
	for _, platform := range platforms {
		if !validPlatform(platform) {
			return nil, ErrInvalidSkill
		}
	}
	sort.Strings(platforms)
	return platforms, nil
}

func indexSkillPolicies(policies []SkillPolicy) map[string]skillPolicySet {
	out := make(map[string]skillPolicySet, len(policies))
	for _, policy := range policies {
		set := out[policy.SkillName]
		if policy.Action == SkillPolicyDisable {
			set.Disable = true
		}
		if policy.Action == SkillPolicyAllowOverride {
			set.AllowOverride = true
		}
		out[policy.SkillName] = set
	}
	return out
}

func indexPlatformConfigs(configs []PlatformConfig) map[string]PlatformConfig {
	out := make(map[string]PlatformConfig, len(configs))
	for _, config := range configs {
		out[config.Platform] = config
	}
	return out
}

func indexCredentialSummaries(credentials []PlatformCredentialSummary) map[string]struct{} {
	out := make(map[string]struct{}, len(credentials))
	for _, credential := range credentials {
		out[credential.Platform] = struct{}{}
	}
	return out
}

func filterEffectiveSkills(skills []EffectiveSkill, filter EffectiveSkillFilter) []EffectiveSkill {
	query := strings.TrimSpace(filter.Query)
	status := strings.TrimSpace(filter.Status)
	if query == "" && status == "" {
		return skills
	}
	filtered := make([]EffectiveSkill, 0, len(skills))
	for _, skill := range skills {
		if query != "" && !strings.Contains(skill.Name, query) &&
			!strings.Contains(skill.DisplayName, query) {
			continue
		}
		if status != "" && skill.Status != status {
			continue
		}
		filtered = append(filtered, skill)
	}
	return filtered
}
