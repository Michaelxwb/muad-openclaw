package runtimeconfig

import (
	"slices"
	"strings"

	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/driver"
	"github.com/Michaelxwb/muad-openclaw/console/backend/internal/repo"
)

type activeIdentity struct {
	agentID string
	record  repo.UserIdentity
	linkKey string
}

func buildRoutesAndLinks(
	podID string, users []repo.HumanUser, identities []repo.UserIdentity,
) ([]driver.RuntimeRoute, []driver.RuntimeIdentityLink, error) {
	agents := make(map[string]string, len(users))
	for _, user := range users {
		agents[user.HumanUserID] = user.AgentID
	}
	active, err := selectActiveIdentities(podID, agents, identities)
	if err != nil {
		return nil, nil, err
	}
	routes := make([]driver.RuntimeRoute, 0, len(active))
	linkCounts := make(map[string]int, len(active))
	for _, identity := range active {
		routes = append(routes, routeFromIdentity(identity))
		if identity.record.PeerKind == "direct" {
			linkCounts[identity.linkKey]++
		}
	}
	sortRoutes(routes)
	return routes, buildIdentityLinks(active, linkCounts), nil
}

func selectActiveIdentities(
	podID string, agents map[string]string, identities []repo.UserIdentity,
) ([]activeIdentity, error) {
	active := make([]activeIdentity, 0, len(identities))
	for _, identity := range identities {
		if identity.PodID != podID {
			return nil, ErrInvalidRuntimeSource
		}
		if identity.Status == repo.IdentityStatusDisabled {
			continue
		}
		if identity.Status != repo.IdentityStatusActive {
			return nil, ErrInvalidRuntimeSource
		}
		agentID, included := agents[identity.HumanUserID]
		if !included {
			continue
		}
		channel, err := runtimeChannel(identity.Channel, identity.OpenClawChannel)
		if err != nil {
			return nil, err
		}
		identity.OpenClawChannel = channel
		active = append(active, activeIdentity{
			agentID: agentID, record: identity,
			linkKey: channel + ":" + identity.ExternalID,
		})
	}
	return active, nil
}

func runtimeChannel(alias, stored string) (string, error) {
	expected := driver.OpenClawChannelFor(alias)
	if strings.TrimSpace(alias) == "" || strings.TrimSpace(stored) == "" || expected != stored {
		return "", ErrInvalidRuntimeSource
	}
	return expected, nil
}

func routeFromIdentity(identity activeIdentity) driver.RuntimeRoute {
	return driver.RuntimeRoute{
		AgentID: identity.agentID, Channel: identity.record.OpenClawChannel,
		AccountID: identity.record.AccountID, PeerKind: identity.record.PeerKind,
		ExternalID: identity.record.ExternalID,
	}
}

func sortRoutes(routes []driver.RuntimeRoute) {
	slices.SortFunc(routes, func(left, right driver.RuntimeRoute) int {
		leftKey := strings.Join([]string{left.Channel, left.AccountID, left.PeerKind, left.ExternalID, left.AgentID}, "\x00")
		rightKey := strings.Join([]string{right.Channel, right.AccountID, right.PeerKind, right.ExternalID, right.AgentID}, "\x00")
		return strings.Compare(leftKey, rightKey)
	})
}

func buildIdentityLinks(active []activeIdentity, counts map[string]int) []driver.RuntimeIdentityLink {
	byAgent := make(map[string][]string)
	for _, identity := range active {
		if identity.record.PeerKind == "direct" && counts[identity.linkKey] == 1 {
			byAgent[identity.agentID] = append(byAgent[identity.agentID], identity.linkKey)
		}
	}
	agentIDs := make([]string, 0, len(byAgent))
	for agentID := range byAgent {
		agentIDs = append(agentIDs, agentID)
	}
	slices.Sort(agentIDs)
	links := make([]driver.RuntimeIdentityLink, 0, len(agentIDs))
	for _, agentID := range agentIDs {
		identities := byAgent[agentID]
		slices.Sort(identities)
		links = append(links, driver.RuntimeIdentityLink{AgentID: agentID, Identities: identities})
	}
	return links
}
