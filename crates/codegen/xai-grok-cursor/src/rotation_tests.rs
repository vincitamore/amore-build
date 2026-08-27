use super::*;

#[test]
fn unrotated_base_resolves_to_itself() {
    assert_eq!(conversation_id_for("base-1"), "base-1");
    assert!(can_rotate("base-1"));
}

#[test]
fn rotation_swaps_the_wire_id_until_the_turn_completes() {
    let first = rotate_conversation_id("base-2");
    assert_eq!(conversation_id_for("base-2"), first);
    assert!(!can_rotate("base-2"), "one rotation per failure streak");
    mark_conversation_completed("base-2");
    assert!(can_rotate("base-2"), "a completed turn re-arms rotation");
    let second = rotate_conversation_id("base-2");
    assert_ne!(first, second);
    assert_eq!(conversation_id_for("base-2"), second);
}

#[test]
fn uuid_rotations_are_well_formed() {
    let rotated = rotate_conversation_id("base-3");
    assert!(uuid::Uuid::parse_str(&rotated).is_ok());
}
