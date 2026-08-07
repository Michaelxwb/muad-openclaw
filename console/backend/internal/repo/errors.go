package repo

// Error is a repo error stamped with an API error code (from internal/errcode).
// The api layer's writeRepoError reads the code via errors.As and emits the
// matching catalog response, replacing the former errors.Is chain.
type Error struct {
	Code int
	Msg  string
}

func (e *Error) Error() string { return e.Msg }
