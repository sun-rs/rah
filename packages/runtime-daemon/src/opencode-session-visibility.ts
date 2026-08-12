/** SQL predicate shared by catalog and exact lookup paths. */
export const OPEN_CODE_HAS_VISIBLE_USER_MESSAGE_SQL = `exists(
  select 1
  from message visible_user
  where visible_user.session_id = s.id
    and json_extract(visible_user.data, '$.role') = 'user'
)`;
