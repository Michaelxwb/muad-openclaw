package api

import "testing"

func TestMSSWChannelCredentials(t *testing.T) {
	good := channelConfigInput{BaseURL: "http://mssw-backend:8765", BotToken: "runtime-reference"}
	if err := validateChannelInput("mssw", good); err != nil {
		t.Fatal(err)
	}
	if err := validateChannelInput("mssw", channelConfigInput{}); err == nil {
		t.Fatal("empty config accepted")
	}
	good.BaseURL = "file:///etc/passwd"
	if err := validateChannelInput("mssw", good); err == nil {
		t.Fatal("invalid URL accepted")
	}
}
