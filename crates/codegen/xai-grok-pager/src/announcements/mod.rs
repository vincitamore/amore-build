//! Fork-owned announcement surfaces beyond the upstream remote slot.
//!
//! Upstream's announcement slot is a promotional channel served from
//! `/v1/settings`. The fork adds surfaces that carry the Amore house
//! context instead — see [`house`].

pub mod house;
