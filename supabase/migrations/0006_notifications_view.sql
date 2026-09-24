-- ============================================================================
-- 5LC TASK CONTROL - 0006 notifications_with_names VIEW
-- Feeds the Notifications screen with recipient / task / extension / reviewer
-- details in one read. Recreated to match the live view.
-- ============================================================================

create or replace view public.notifications_with_names as
select
  n.id            as notification_id,
  n.user_id       as recipient_uuid,
  rp.full_name    as recipient_name,
  rp.employee_id  as recipient_employee_id,
  rp.role         as recipient_role,
  rp.department   as recipient_department,
  n.type,
  n.title,
  n.message,
  n.is_read,
  n.created_at,
  n.task_id,
  t.title         as task_title,
  t.status        as task_status,
  t.priority      as task_priority,
  t.due_date      as task_due_date,
  n.extension_id,
  e.old_due_date,
  e.requested_due_date,
  e.reason        as extension_reason,
  e.status        as extension_status,
  e.requested_by  as requester_uuid,
  qp.full_name    as requester_name,
  qp.employee_id  as requester_employee_id,
  qp.role         as requester_role,
  qp.department   as requester_department,
  e.reviewed_by   as reviewer_uuid,
  vp.full_name    as reviewer_name,
  vp.employee_id  as reviewer_employee_id,
  vp.role         as reviewer_role,
  vp.department   as reviewer_department,
  e.reviewed_at,
  e.review_comment
from public.notifications n
left join public.profiles rp on rp.id = n.user_id
left join public.tasks t on t.id = n.task_id
left join public.task_extensions e on e.id = n.extension_id
left join public.profiles qp on qp.id = e.requested_by
left join public.profiles vp on vp.id = e.reviewed_by;

-- Views run with the querying user's RLS on the underlying tables (Postgres 15+
-- with security_invoker). If your project is older, mark it explicitly:
alter view public.notifications_with_names set (security_invoker = true);
