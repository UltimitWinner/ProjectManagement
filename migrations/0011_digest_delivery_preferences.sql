ALTER TABLE user_email_preferences
  ADD COLUMN lookahead_days INTEGER NOT NULL DEFAULT 7;

ALTER TABLE user_email_preferences
  ADD COLUMN include_undated_open INTEGER NOT NULL DEFAULT 0;

ALTER TABLE user_email_preferences
  ADD COLUMN weekend_delivery TEXT NOT NULL DEFAULT 'always';

ALTER TABLE user_email_preferences
  ADD COLUMN holiday_delivery TEXT NOT NULL DEFAULT 'always';
