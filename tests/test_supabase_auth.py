import io
import json
import unittest
import urllib.error
from unittest.mock import MagicMock, patch

import app
from supabase_auth import AuthStatusUnavailable, SupabaseAuth


class SupabaseAuthTests(unittest.TestCase):
    def setUp(self):
        self.auth = SupabaseAuth(
            'https://project.supabase.co',
            'https://project.supabase.co/auth/v1/.well-known/jwks.json',
            'server-secret',
        )

    def mock_user(self, **values):
        user = {'id': 'user-123', **values}
        response = MagicMock()
        response.__enter__.return_value = response
        response.read.return_value = json.dumps(user).encode()
        return response

    @patch('supabase_auth.urllib.request.urlopen')
    def test_user_without_ban_is_active(self, urlopen):
        urlopen.return_value = self.mock_user(banned_until=None)

        self.assertTrue(self.auth.is_user_active('user-123'))
        request = urlopen.call_args.args[0]
        self.assertEqual(request.get_header('Apikey'), 'server-secret')
        self.assertEqual(request.get_header('Authorization'), 'Bearer server-secret')

    @patch('supabase_auth.urllib.request.urlopen')
    def test_currently_banned_user_is_inactive(self, urlopen):
        urlopen.return_value = self.mock_user(banned_until='2999-01-01T00:00:00Z')

        self.assertFalse(self.auth.is_user_active('user-123'))

    @patch('supabase_auth.urllib.request.urlopen')
    def test_expired_ban_is_active(self, urlopen):
        urlopen.return_value = self.mock_user(banned_until='2000-01-01T00:00:00Z')

        self.assertTrue(self.auth.is_user_active('user-123'))

    @patch('supabase_auth.urllib.request.urlopen')
    def test_deleted_user_is_inactive(self, urlopen):
        urlopen.return_value = self.mock_user(deleted_at='2026-01-01T00:00:00Z')

        self.assertFalse(self.auth.is_user_active('user-123'))

    @patch('supabase_auth.urllib.request.urlopen')
    def test_missing_user_is_inactive(self, urlopen):
        urlopen.side_effect = urllib.error.HTTPError(
            'https://project.supabase.co', 404, 'Not Found', {}, io.BytesIO(),
        )

        self.assertFalse(self.auth.is_user_active('user-123'))

    @patch('supabase_auth.urllib.request.urlopen')
    def test_admin_api_failure_is_not_treated_as_active(self, urlopen):
        urlopen.side_effect = urllib.error.URLError('network unavailable')

        with self.assertRaises(AuthStatusUnavailable):
            self.auth.is_user_active('user-123')

    @patch('supabase_auth.urllib.request.urlopen')
    def test_mismatched_user_id_is_rejected(self, urlopen):
        urlopen.return_value = self.mock_user(id='other-user')

        with self.assertRaises(AuthStatusUnavailable):
            self.auth.is_user_active('user-123')

    @patch.object(app, 'API_ROUTES', [])
    @patch.object(app, 'SUPABASE_AUTH')
    def test_api_denies_inactive_user_on_each_request(self, auth):
        auth.validate.return_value = {'sub': 'user-123'}
        auth.is_user_active.return_value = False

        response = app._dispatch_api(
            'GET', '/api/bootstrap', '', {}, 'Bearer valid-token',
        )

        self.assertEqual(response.status_code, 403)
        auth.is_user_active.assert_called_once_with('user-123')

    @patch.object(app, 'SUPABASE_AUTH')
    def test_api_fails_closed_when_active_status_is_unavailable(self, auth):
        auth.validate.return_value = {'sub': 'user-123'}
        auth.is_user_active.side_effect = AuthStatusUnavailable('offline')

        response = app._dispatch_api(
            'GET', '/api/bootstrap', '', {}, 'Bearer valid-token',
        )

        self.assertEqual(response.status_code, 503)


if __name__ == '__main__':
    unittest.main()
