Always write tests before merging any change. This is non-negotiable
and applies to every PR regardless of size.

Never commit directly to main. All changes go through a pull request
and require at least one review from another engineer.

Keep functions under 50 lines. If a function grows past that, treat it
as a signal to extract a helper rather than adding another branch.
