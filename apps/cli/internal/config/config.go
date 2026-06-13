package config

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

const (
	DefaultAPIURL = "https://supanow.launchpad.hconsulting.mx"
	configFile    = "config.json"
	linkFile      = ".supanow"
)

type Config struct {
	APIToken string `json:"api_token"`
	APIURL   string `json:"api_url,omitempty"`
}

type LinkConfig struct {
	ProjectRef string `json:"project_ref"`
	ProjectURL string `json:"project_url"`
}

func configDir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".supanow"), nil
}

func Load() (*Config, error) {
	dir, err := configDir()
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(filepath.Join(dir, configFile))
	if err != nil {
		if os.IsNotExist(err) {
			return &Config{APIURL: DefaultAPIURL}, nil
		}
		return nil, err
	}
	var cfg Config
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, err
	}
	if cfg.APIURL == "" {
		cfg.APIURL = DefaultAPIURL
	}
	return &cfg, nil
}

func Save(cfg *Config) error {
	dir, err := configDir()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, configFile), data, 0600)
}

func LoadLink() (*LinkConfig, error) {
	data, err := os.ReadFile(linkFile)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, fmt.Errorf("not linked to a project — run: supanow link --project-ref <ref>")
		}
		return nil, err
	}
	var lc LinkConfig
	if err := json.Unmarshal(data, &lc); err != nil {
		return nil, err
	}
	return &lc, nil
}

func SaveLink(lc *LinkConfig) error {
	data, err := json.MarshalIndent(lc, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(linkFile, data, 0644)
}
