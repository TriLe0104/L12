from typing import Set, Optional


class ConfigManager:
    """Manages configuration and filtering for sensor groups."""

    def __init__(self,
                 include_cpu_temperatures: Optional[bool] = True,
                 include_gpu_temperatures: Optional[bool] = True,
                 include_memory_dimm_temperatures: Optional[bool] = True,
                 include_vrm_temperatures: Optional[bool] = True,
                 include_storage_temperatures: Optional[bool] = True,
                 include_network_card_temperatures: Optional[bool] = True,
                 include_pcie_plx_temperatures: Optional[bool] = True,
                 include_hgx_temperatures: Optional[bool] = True,
                 include_system_temperatures: Optional[bool] = True,
                 include_fan_speeds: Optional[bool] = False,
                 include_motherboard_voltages: Optional[bool] = True,
                 include_cpu_voltages: Optional[bool] = False,
                 include_system_power: Optional[bool] = True,
                 include_psu_power_input: Optional[bool] = False,
                 include_psu_power_output: Optional[bool] = True,
                 include_psu_efficiency: Optional[bool] = False):
        # Set defaults if None
        self.include_cpu_temperatures = include_cpu_temperatures if include_cpu_temperatures is not None else True
        self.include_gpu_temperatures = include_gpu_temperatures if include_gpu_temperatures is not None else True
        self.include_memory_dimm_temperatures = include_memory_dimm_temperatures if include_memory_dimm_temperatures is not None else True
        self.include_vrm_temperatures = include_vrm_temperatures if include_vrm_temperatures is not None else True
        self.include_storage_temperatures = include_storage_temperatures if include_storage_temperatures is not None else True
        self.include_network_card_temperatures = include_network_card_temperatures if include_network_card_temperatures is not None else True
        self.include_pcie_plx_temperatures = include_pcie_plx_temperatures if include_pcie_plx_temperatures is not None else True
        self.include_hgx_temperatures = include_hgx_temperatures if include_hgx_temperatures is not None else True
        self.include_system_temperatures = include_system_temperatures if include_system_temperatures is not None else True
        self.include_fan_speeds = include_fan_speeds if include_fan_speeds is not None else False
        self.include_motherboard_voltages = include_motherboard_voltages if include_motherboard_voltages is not None else True
        self.include_cpu_voltages = include_cpu_voltages if include_cpu_voltages is not None else True
        self.include_system_power = include_system_power if include_system_power is not None else True
        self.include_psu_power_input = include_psu_power_input if include_psu_power_input is not None else False
        self.include_psu_power_output = include_psu_power_output if include_psu_power_output is not None else True
        self.include_psu_efficiency = include_psu_efficiency if include_psu_efficiency is not None else False

    def get_included_groups(self) -> Set[str]:
        """Get the set of sensor groups that should be included in the report."""
        group_flag_map = {
            'CPU Temperatures': self.include_cpu_temperatures,
            'GPU Temperatures': self.include_gpu_temperatures,
            'Memory (DIMM) Temperatures': self.include_memory_dimm_temperatures,
            'VRM Temperatures': self.include_vrm_temperatures,
            'Storage Temperatures': self.include_storage_temperatures,
            'Network Card Temperatures': self.include_network_card_temperatures,
            'PCIe/PLX Temperatures': self.include_pcie_plx_temperatures,
            'HGX Temperatures': self.include_hgx_temperatures,
            'System Temperatures': self.include_system_temperatures,
            'Fan Speeds': self.include_fan_speeds,
            'Motherboard Voltages': self.include_motherboard_voltages,
            'CPU Voltages': self.include_cpu_voltages,
            'System Power': self.include_system_power,
            'PSU Power Input': self.include_psu_power_input,
            'PSU Power Output': self.include_psu_power_output,
            'PSU Efficiency': self.include_psu_efficiency
        }
        return {group for group, flag in group_flag_map.items() if flag}