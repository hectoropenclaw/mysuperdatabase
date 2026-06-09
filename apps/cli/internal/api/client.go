package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

type Client struct {
	baseURL    string
	token      string
	httpClient *http.Client
}

func New(baseURL, token string) *Client {
	return &Client{
		baseURL: baseURL,
		token:   token,
		httpClient: &http.Client{
			Timeout: 30 * time.Second,
		},
	}
}

func (c *Client) do(method, path string, body any) ([]byte, int, error) {
	var bodyReader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return nil, 0, err
		}
		bodyReader = bytes.NewReader(data)
	}

	req, err := http.NewRequest(method, c.baseURL+path, bodyReader)
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()

	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, resp.StatusCode, err
	}
	return data, resp.StatusCode, nil
}

// ─── Projects ─────────────────────────────────────────────────────────────────

type Project struct {
	Ref      string `json:"ref"`
	Name     string `json:"name"`
	Status   string `json:"status"`
	SiteURL  string `json:"site_url"`
	OrgID    string `json:"org_id"`
}

func (c *Client) ListProjects() ([]Project, error) {
	data, status, err := c.do("GET", "/api/v1/projects", nil)
	if err != nil {
		return nil, err
	}
	if status != 200 {
		return nil, fmt.Errorf("API error %d: %s", status, string(data))
	}
	var resp struct {
		Projects []Project `json:"projects"`
	}
	return resp.Projects, json.Unmarshal(data, &resp)
}

func (c *Client) GetProject(ref string) (*Project, error) {
	data, status, err := c.do("GET", "/api/v1/projects/"+ref, nil)
	if err != nil {
		return nil, err
	}
	if status != 200 {
		return nil, fmt.Errorf("API error %d: %s", status, string(data))
	}
	var resp struct {
		Project Project `json:"project"`
	}
	return &resp.Project, json.Unmarshal(data, &resp)
}

type CreateProjectInput struct {
	Name  string `json:"name"`
	OrgID string `json:"org_id"`
}

func (c *Client) CreateProject(input CreateProjectInput) (*Project, error) {
	data, status, err := c.do("POST", "/api/v1/projects", input)
	if err != nil {
		return nil, err
	}
	if status != 201 {
		return nil, fmt.Errorf("API error %d: %s", status, string(data))
	}
	var resp struct {
		Project Project `json:"project"`
	}
	return &resp.Project, json.Unmarshal(data, &resp)
}

func (c *Client) DeleteProject(ref string) error {
	data, status, err := c.do("DELETE", "/api/v1/projects/"+ref, nil)
	if err != nil {
		return err
	}
	if status != 200 {
		return fmt.Errorf("API error %d: %s", status, string(data))
	}
	return nil
}

// ─── Keys ─────────────────────────────────────────────────────────────────────

type ProjectKeys struct {
	AnonKey        string `json:"anon_key"`
	ServiceRoleKey string `json:"service_role_key"`
	URL            string `json:"url"`
}

func (c *Client) GetProjectKeys(ref string) (*ProjectKeys, error) {
	data, status, err := c.do("GET", "/api/v1/projects/"+ref+"/keys", nil)
	if err != nil {
		return nil, err
	}
	if status != 200 {
		return nil, fmt.Errorf("API error %d: %s", status, string(data))
	}
	var keys ProjectKeys
	return &keys, json.Unmarshal(data, &keys)
}

// ─── Orgs ─────────────────────────────────────────────────────────────────────

type Org struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Slug string `json:"slug"`
	Plan string `json:"plan"`
	Role string `json:"role"`
}

func (c *Client) ListOrgs() ([]Org, error) {
	data, status, err := c.do("GET", "/api/v1/orgs", nil)
	if err != nil {
		return nil, err
	}
	if status != 200 {
		return nil, fmt.Errorf("API error %d: %s", status, string(data))
	}
	var resp struct {
		Orgs []Org `json:"orgs"`
	}
	return resp.Orgs, json.Unmarshal(data, &resp)
}

// ─── Functions ────────────────────────────────────────────────────────────────

type Function struct {
	ID             string `json:"id"`
	Slug           string `json:"slug"`
	Name           string `json:"name"`
	Status         string `json:"status"`
	VerifyJWT      bool   `json:"verify_jwt"`
	EntrypointPath string `json:"entrypoint_path"`
}

func (c *Client) ListFunctions(ref string) ([]Function, error) {
	data, status, err := c.do("GET", "/api/v1/projects/"+ref+"/functions", nil)
	if err != nil {
		return nil, err
	}
	if status != 200 {
		return nil, fmt.Errorf("API error %d: %s", status, string(data))
	}
	var fns []Function
	return fns, json.Unmarshal(data, &fns)
}

type DeployFunctionInput struct {
	Slug      string                    `json:"slug"`
	Name      string                    `json:"name"`
	VerifyJWT bool                      `json:"verify_jwt"`
	Files     []struct{ Name string }   `json:"files"`
}

func (c *Client) DeployFunction(ref string, slug string, name string, verifyJWT bool, files map[string]string) (*Function, error) {
	// Build multipart form
	var buf bytes.Buffer
	mw := &multipartHelper{buf: &buf}

	mw.writeField("slug", slug)
	mw.writeField("name", name)
	if verifyJWT {
		mw.writeField("verify_jwt", "true")
	} else {
		mw.writeField("verify_jwt", "false")
	}

	filesJSON := "["
	for name := range files {
		filesJSON += fmt.Sprintf(`{"name":%q},`, name)
	}
	if len(files) > 0 {
		filesJSON = filesJSON[:len(filesJSON)-1]
	}
	filesJSON += "]"
	mw.writeField("files", filesJSON)

	for name, content := range files {
		mw.writeFile(name, []byte(content))
	}

	boundary := mw.boundary
	req, err := http.NewRequest("POST", c.baseURL+"/api/v1/projects/"+ref+"/functions", &buf)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Content-Type", "multipart/form-data; boundary="+boundary)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 201 {
		return nil, fmt.Errorf("API error %d: %s", resp.StatusCode, string(data))
	}
	var fn Function
	return &fn, json.Unmarshal(data, &fn)
}

type multipartHelper struct {
	buf      *bytes.Buffer
	boundary string
}

func (m *multipartHelper) writeField(name, value string) {
	if m.boundary == "" {
		m.boundary = fmt.Sprintf("boundary%d", time.Now().UnixNano())
	}
	fmt.Fprintf(m.buf, "--%s\r\nContent-Disposition: form-data; name=%q\r\n\r\n%s\r\n", m.boundary, name, value)
}

func (m *multipartHelper) writeFile(name string, content []byte) {
	if m.boundary == "" {
		m.boundary = fmt.Sprintf("boundary%d", time.Now().UnixNano())
	}
	fmt.Fprintf(m.buf, "--%s\r\nContent-Disposition: form-data; name=%q; filename=%q\r\n\r\n", m.boundary, name, name)
	m.buf.Write(content)
	fmt.Fprint(m.buf, "\r\n")
}

func (c *Client) DeleteFunction(ref, slug string) error {
	data, status, err := c.do("DELETE", "/api/v1/projects/"+ref+"/functions/"+slug, nil)
	if err != nil {
		return err
	}
	if status != 200 {
		return fmt.Errorf("API error %d: %s", status, string(data))
	}
	return nil
}

// ─── Secrets ──────────────────────────────────────────────────────────────────

type Secret struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type SecretInput struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

func (c *Client) UpsertSecrets(ref string, secrets []SecretInput) error {
	data, status, err := c.do("POST", "/api/v1/projects/"+ref+"/secrets", secrets)
	if err != nil {
		return err
	}
	if status != 200 {
		return fmt.Errorf("API error %d: %s", status, string(data))
	}
	return nil
}

func (c *Client) DeleteSecrets(ref string, names []string) error {
	type nameObj struct {
		Name string `json:"name"`
	}
	body := make([]nameObj, len(names))
	for i, n := range names {
		body[i] = nameObj{Name: n}
	}
	data, status, err := c.do("DELETE", "/api/v1/projects/"+ref+"/secrets", body)
	if err != nil {
		return err
	}
	if status != 200 {
		return fmt.Errorf("API error %d: %s", status, string(data))
	}
	return nil
}
