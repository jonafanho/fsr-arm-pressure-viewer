"""CH340 detection used to auto-select the one FSR board."""
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import core


def port(device, vid=None, pid=None, description='', manufacturer='', hwid='', serial_number=''):
    return SimpleNamespace(device=device, vid=vid, pid=pid, description=description,
                           manufacturer=manufacturer, hwid=hwid, serial_number=serial_number)


CH340 = port('COM7', 0x1A86, 0x7523, 'USB-SERIAL CH340', 'wch.cn',
             'USB VID:PID=1A86:7523 SER=1', 'CH340-SERIAL')
CH340_2 = port('COM8', 0x1A86, 0x7523, 'USB-SERIAL CH340', 'wch.cn',
               'USB VID:PID=1A86:7523 SER=2', 'CH340-OTHER')
CP210X = port('COM4', 0x10C4, 0xEA60, 'Silicon Labs CP210x', 'Silicon Labs',
              'USB VID:PID=10C4:EA60', '')


class PortKindTests(unittest.TestCase):
    def test_ch340_is_recognised_by_vendor_id(self):
        self.assertEqual(core.port_kind(CH340), 'ch340')

    def test_ch340_is_recognised_when_the_driver_hides_the_vendor_id(self):
        hidden = port('COM9', description='USB-SERIAL CH340 (COM9)')
        self.assertEqual(core.port_kind(hidden), 'ch340')

    def test_other_bridges_are_not_ch340(self):
        self.assertEqual(core.port_kind(CP210X), 'cp210x')
        self.assertEqual(core.port_kind(port('COM1', description='FT232R USB UART')), 'ftdi')
        self.assertEqual(core.port_kind(port('COM2', description='Standard Serial over Bluetooth')), 'unknown')


class ChoosePortTests(unittest.TestCase):
    def choose(self, ports):
        with patch('core.list_ports.comports', return_value=ports):
            return core.choose_port(core.serial_port_list())

    def test_a_lone_port_is_used_even_without_a_known_chip(self):
        chosen = self.choose([CP210X])
        self.assertEqual(chosen['device'], 'COM4')

    def test_one_ch340_wins_over_unrelated_adapters(self):
        chosen = self.choose([CP210X, CH340])
        self.assertEqual(chosen['device'], 'COM7')
        self.assertTrue(chosen['ch340'])

    def test_two_ch340_boards_stay_a_manual_choice(self):
        self.assertIsNone(self.choose([CH340, CH340_2]))

    def test_no_ports_means_no_choice(self):
        self.assertIsNone(self.choose([]))


class PortListTests(unittest.TestCase):
    def test_each_port_is_annotated_for_the_ui(self):
        with patch('core.list_ports.comports', return_value=[CP210X, CH340]):
            ports = core.serial_port_list()
        self.assertEqual([item['device'] for item in ports], ['COM4', 'COM7'])
        self.assertEqual([item['kind'] for item in ports], ['cp210x', 'ch340'])
        self.assertEqual([item['ch340'] for item in ports], [False, True])
        self.assertEqual(ports[1]['serial_number'], 'CH340-SERIAL')
        self.assertEqual(ports[0]['vid'], 0x10C4)

    def test_missing_pyserial_returns_an_empty_list(self):
        with patch.object(core, 'list_ports', None):
            self.assertEqual(core.serial_port_list(), [])


if __name__ == '__main__':
    unittest.main()
