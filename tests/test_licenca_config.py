import os
import unittest
from unittest.mock import patch

import licenca


class LicenseConfigurationTests(unittest.TestCase):
    def test_secret_is_loaded_from_environment(self):
        secret_hex = 'ab' * 32
        with patch.dict(os.environ, {'MINIERP_LICENCA_SECRET': secret_hex}):
            self.assertEqual(licenca._segredo(), bytes.fromhex(secret_hex))

    def test_missing_secret_is_rejected(self):
        with patch.dict(os.environ, {'MINIERP_LICENCA_SECRET': ''}):
            with self.assertRaises(licenca.LicencaErro):
                licenca._segredo()

    def test_malformed_secret_is_rejected(self):
        with patch.dict(os.environ, {'MINIERP_LICENCA_SECRET': 'not-hex'}):
            with self.assertRaises(licenca.LicencaErro):
                licenca._segredo()


if __name__ == '__main__':
    unittest.main()
